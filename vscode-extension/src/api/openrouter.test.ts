// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenRouter } from './openrouter';

// Builds a fake streaming Response out of raw SSE lines — each entry in
// `lines` becomes one line of the wire format (including the blank
// lines that separate events); pass pre-formatted 'data: {...}' strings
// so tests can control line-splitting precisely (e.g. one JSON payload
// deliberately split across two 'data:' lines, mirroring the real
// framing bug this file's own parser was rewritten to handle).
function mockSseResponse(lines: string[]): Response {
  const body = lines.map((l) => l + '\n').join('');
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function dataLine(payload: object): string {
  return 'data: ' + JSON.stringify(payload);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callOpenRouter', () => {
  it('surfaces finishReason "length" when the completion was cut off by max_tokens', async () => {
    const res = mockSseResponse([
      dataLine({ model: 'test/model', choices: [{ delta: { content: 'partial' } }] }),
      '',
      dataLine({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      '',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const result = await callOpenRouter('fake-key', 'test/model', [{ role: 'user', content: 'hi' }]);
    expect(result.finishReason).toBe('length');
  });

  it('leaves finishReason as "stop" (not "length") for a normal completion', async () => {
    const res = mockSseResponse([
      dataLine({ model: 'test/model', choices: [{ delta: { content: 'done' } }] }),
      '',
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const result = await callOpenRouter('fake-key', 'test/model', [{ role: 'user', content: 'hi' }]);
    expect(result.finishReason).toBe('stop');
  });

  it('reassembles a tool call whose arguments are split across multiple delta chunks', async () => {
    const res = mockSseResponse([
      dataLine({
        model: 'test/model',
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":' } }] } }],
      }),
      '',
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x.txt","content":"hi"}' } }] } }] }),
      '',
      dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const result = await callOpenRouter('fake-key', 'test/model', [{ role: 'user', content: 'hi' }]);
    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls![0].function.name).toBe('write_file');
    expect(JSON.parse(result.message.tool_calls![0].function.arguments)).toEqual({ path: 'x.txt', content: 'hi' });
  });

  it('correctly joins one SSE event whose data is legitimately split across consecutive data: lines', async () => {
    // Per spec: multiple consecutive 'data:' lines before a blank line
    // belong to the SAME event and must be joined with '\n' before
    // parsing as one JSON payload — not treated as two independent
    // events. Regression test for the framing bug fixed earlier this
    // project's history (see this file's own processEvent comment).
    const payload = JSON.stringify({ model: 'test/model', choices: [{ delta: { content: 'hello' } }] });
    const half = Math.floor(payload.length / 2);
    const res = mockSseResponse([
      'data: ' + payload.slice(0, half),
      'data: ' + payload.slice(half),
      '',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const onDelta = vi.fn();
    const result = await callOpenRouter('fake-key', 'test/model', [{ role: 'user', content: 'hi' }], undefined, { onDelta });
    expect(onDelta).toHaveBeenCalledWith('hello');
    expect(result.message.content).toBe('hello');
  });

  it('throws with the API-provided error message on a non-OK response', async () => {
    const errBody = JSON.stringify({ error: { message: 'insufficient credits' } });
    const res = new Response(errBody, { status: 402 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    await expect(callOpenRouter('fake-key', 'test/model', [{ role: 'user', content: 'hi' }])).rejects.toThrow('insufficient credits');
  });
});
