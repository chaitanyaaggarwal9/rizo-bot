// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callBedrock,
  fromConverseResponse,
  isValidBedrockModelId,
  isValidRegion,
  listBedrockModels,
  toConverseRequest,
  verifyBedrock,
} from './bedrock';
import type { ChatMessage } from './openrouter';
import { TOOLS } from '../tools/tools';
import { encodeEventStreamMessage } from './eventStream';

function ev(type: string, payload: unknown): Uint8Array {
  return encodeEventStreamMessage({ ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' }, JSON.stringify(payload));
}

function streamResponse(frames: Uint8Array[], pieceSize = 0): Response {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    all.set(f, o);
    o += f.length;
  }
  const pieces = pieceSize ? Array.from({ length: Math.ceil(all.length / pieceSize) }, (_, i) => all.slice(i * pieceSize, (i + 1) * pieceSize)) : frames;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of pieces) c.enqueue(p);
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/vnd.amazon.eventstream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('region and model id validation', () => {
  it('accepts real AWS regions and nothing that could change the host', () => {
    for (const r of ['us-east-1', 'eu-west-3', 'ap-southeast-2', 'us-gov-west-1', 'ca-central-1', 'il-central-1']) expect(isValidRegion(r)).toBe(true);
    for (const r of ['', 'US-EAST-1', 'us-east-1.evil.com', 'us-east', 'evil.com/', 'us-east-1/', '../x', 'us east 1']) expect(isValidRegion(r)).toBe(false);
  });

  it('accepts model ids, inference profiles and ARNs', () => {
    for (const id of [
      'anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'amazon.nova-pro-v1:0',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-x',
    ]) {
      expect(isValidBedrockModelId(id)).toBe(true);
    }
    for (const id of ['', 'a', '../../x', 'x y', 'model?x=1', 'http://evil']) expect(isValidBedrockModelId(id)).toBe(false);
  });
});

describe('toConverseRequest', () => {
  it('moves system prompts out, keeps alternation and turns tool results into user blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be careful.' },
      { role: 'user', content: 'read a.ts' },
      {
        role: 'assistant',
        content: 'Reading it.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1;' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Error: file not found' },
      { role: 'user', content: 'thanks' },
    ];
    const req = toConverseRequest(messages, TOOLS.slice(0, 1), 4096);
    expect(req.system).toEqual([{ text: 'Be careful.' }]);
    expect(req.inferenceConfig).toEqual({ maxTokens: 4096 });
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req.messages[1].content).toEqual([
      { text: 'Reading it.' },
      { toolUse: { toolUseId: 'call_1', name: 'read_file', input: { path: 'a.ts' } } },
    ]);
    expect(req.messages[2].content).toEqual([
      { toolResult: { toolUseId: 'call_1', content: [{ text: 'export const a = 1;' }], status: 'success' } },
      { toolResult: { toolUseId: 'call_2', content: [{ text: 'Error: file not found' }], status: 'error' } },
      { text: 'thanks' },
    ]);
    expect(req.toolConfig?.tools[0].toolSpec.name).toBe('read_file');
    expect(req.toolConfig?.tools[0].toolSpec.inputSchema.json).toEqual(TOOLS[0].function.parameters);
  });

  it('converts image attachments, drops empty text and starts with a user turn', () => {
    const req = toConverseRequest([
      { role: 'assistant', content: '' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/jpg;base64,QUJD' } },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ],
      },
    ]);
    expect(req.messages).toEqual([
      { role: 'user', content: [{ text: 'what is this?' }, { image: { format: 'jpeg', source: { bytes: 'QUJD' } } }] },
    ]);
    expect(req).not.toHaveProperty('toolConfig');
    expect(req).not.toHaveProperty('inferenceConfig');
  });

  it('never sends malformed tool arguments as a non-object', () => {
    const req = toConverseRequest([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'write_file', arguments: '{"path":"x' } }] },
    ]);
    expect(req.messages[1].content[0]).toEqual({ toolUse: { toolUseId: 'c', name: 'write_file', input: {} } });
  });
});

describe('fromConverseResponse', () => {
  it('maps text, tool use, usage and stop reasons', () => {
    const r = fromConverseResponse(
      {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Let me check.' }, { toolUse: { toolUseId: 'tu1', name: 'read_file', input: { path: 'b.ts' } } }],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
      'us.anthropic.claude-x',
    );
    expect(r).toEqual({
      model: 'us.anthropic.claude-x',
      message: {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }],
      },
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      finishReason: 'tool_calls',
    });
    expect(fromConverseResponse({ output: { message: { content: [{ text: 'cut' }] } }, stopReason: 'max_tokens' }, 'm').finishReason).toBe('length');
    expect(fromConverseResponse({}, 'm').message.content).toBeNull();
  });
});

describe('callBedrock', () => {
  it('streams from the regional converse-stream URL with the key', async () => {
    const f = vi.fn().mockResolvedValue(
      streamResponse([
        ev('messageStart', { role: 'assistant' }),
        ev('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hel' } }),
        ev('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'lo' } }),
        ev('contentBlockStop', { contentBlockIndex: 0 }),
        ev('messageStop', { stopReason: 'end_turn' }),
        ev('metadata', { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
      ]),
    );
    vi.stubGlobal('fetch', f);
    const deltas: string[] = [];
    const r = await callBedrock({ region: 'us-east-1' }, 'ABSK-key', 'us.anthropic.claude-x', [{ role: 'user', content: 'hi' }], undefined, {
      onDelta: (t) => deltas.push(t),
      maxTokens: 500,
    });
    expect(f.mock.calls[0][0]).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-x/converse-stream');
    expect(((f.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer ABSK-key');
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).inferenceConfig).toEqual({ maxTokens: 500 });
    expect(deltas).toEqual(['hel', 'lo']);
    expect(r.message.content).toBe('hello');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.totalTokens).toBe(4);
  });

  it('collects streamed tool calls, split across chunks and frames', async () => {
    const f = vi.fn().mockResolvedValue(
      streamResponse(
        [
          ev('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Reading it.' } }),
          ev('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu_1', name: 'read_file' } } }),
          ev('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":' } } }),
          ev('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"src/a.ts"}' } } }),
          ev('contentBlockStart', { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tu_2', name: 'list_directory' } } }),
          ev('messageStop', { stopReason: 'tool_use' }),
          ev('metadata', { usage: { inputTokens: 10, outputTokens: 5 } }),
        ],
        7, // deliver in 7-byte pieces so frames straddle reads
      ),
    );
    vi.stubGlobal('fetch', f);
    const r = await callBedrock({ region: 'us-east-1' }, 'k', 'amazon.nova-pro-v1:0', [{ role: 'user', content: 'hi' }], TOOLS);
    expect(r.message.content).toBe('Reading it.');
    expect(r.message.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
      { id: 'tu_2', type: 'function', function: { name: 'list_directory', arguments: '{}' } },
    ]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.usage.totalTokens).toBe(15);
  });

  it('turns a stream exception into an error with the matching status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([
          ev('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'partial' } }),
          encodeEventStreamMessage({ ':message-type': 'exception', ':exception-type': 'throttlingException' }, JSON.stringify({ message: 'Too many requests' })),
        ]),
      ),
    );
    await expect(callBedrock({ region: 'us-east-1' }, 'k', 'amazon.nova-pro-v1:0', [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      message: 'Too many requests',
      status: 429,
    });
  });

  it('fails clearly when the stream is cut off', async () => {
    const whole = ev('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'x' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([whole.slice(0, whole.length - 3)])));
    await expect(callBedrock({ region: 'us-east-1' }, 'k', 'amazon.nova-pro-v1:0', [{ role: 'user', content: 'hi' }])).rejects.toThrow('ended early');
  });

  it('falls back to plain Converse when the model cannot stream', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'This model doesn\'t support tool use in streaming mode.' }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { message: { content: [{ text: 'whole' }] } }, stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 1 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', f);
    const deltas: string[] = [];
    const r = await callBedrock({ region: 'us-east-1' }, 'k', 'meta.llama-x', [{ role: 'user', content: 'hi' }], TOOLS, { onDelta: (t) => deltas.push(t) });
    expect(f.mock.calls[1][0]).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/meta.llama-x/converse');
    expect((f.mock.calls[1][1] as RequestInit).body).toBe((f.mock.calls[0][1] as RequestInit).body);
    expect(r.message.content).toBe('whole');
    expect(deltas).toEqual(['whole']);
  });

  it('encodes ARNs in the path and surfaces AWS error messages', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'The security token included in the request is invalid.' }), { status: 403 }));
    vi.stubGlobal('fetch', f);
    await expect(
      callBedrock({ region: 'us-west-2' }, 'k', 'arn:aws:bedrock:us-west-2:1:inference-profile/us.x', [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('security token');
    expect(f.mock.calls[0][0]).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aus-west-2%3A1%3Ainference-profile%2Fus.x/converse-stream');
  });

  it('refuses an invalid region or model id before sending anything', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(callBedrock({ region: 'evil.com' }, 'k', 'amazon.nova-pro-v1:0', [])).rejects.toThrow(/valid AWS region/);
    await expect(callBedrock({ region: 'us-east-1' }, 'k', '../x', [])).rejects.toThrow(/valid Bedrock model id/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('listBedrockModels and verifyBedrock', () => {
  it('lists inference profiles and on-demand models, or [] when not allowed', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('inference-profiles')
        ? new Response(JSON.stringify({ inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.claude-x' }] }), { status: 200 })
        : new Response(JSON.stringify({ modelSummaries: [{ modelId: 'amazon.nova-pro-v1:0' }, { modelId: 'bad id' }] }), { status: 200 }),
    );
    expect(await listBedrockModels('us-east-1', 'k', f as unknown as typeof fetch)).toEqual(['amazon.nova-pro-v1:0', 'us.anthropic.claude-x']);
    expect(await listBedrockModels('us-east-1', 'k', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))).toEqual([]);
  });

  it('explains key, model and network problems', async () => {
    const res = (status: number, message: string) => vi.fn().mockResolvedValue(new Response(JSON.stringify({ message }), { status }));
    expect(await verifyBedrock('us-east-1', 'k', 'm.x-v1:0', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))).toBeUndefined();
    expect(await verifyBedrock('us-east-1', 'k', 'm.x-v1:0', res(403, 'denied'))).toMatch(/rejected the key/);
    expect(
      await verifyBedrock('us-east-1', 'k', 'anthropic.claude-x', res(400, "Invocation of model ID anthropic.claude-x with on-demand throughput isn't supported")),
    ).toMatch(/inference profile/);
    expect(await verifyBedrock('us-east-1', 'k', 'm.x-v1:0', vi.fn().mockRejectedValue(new Error('ENOTFOUND')))).toMatch(/Couldn't reach Bedrock/);
  });
});
