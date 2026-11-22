// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Amazon Bedrock with the user's own Bedrock API key, through AWS's
// Converse API (POST https://bedrock-runtime.<region>.amazonaws.com/
// model/<modelId>/converse, "Authorization: Bearer <key>"). Converse is
// used instead of Bedrock's OpenAI-compatible endpoint because that one
// doesn't support Claude models. No AWS SDK: this file translates Rizo's
// OpenAI-style messages and tool calls to Converse and back.
// Replies stream through ConverseStream (".../converse-stream"), whose
// binary event-stream framing is decoded in eventStream.ts. Models that
// can't stream (or can't stream with tools) fall back to plain Converse.
// No 'vscode' import: tested in bedrock.test.ts.

import { ToolDefinition } from '../tools/tools';
import { EventStreamDecoder } from './eventStream';
import { AssistantMessage, CallOptions, ChatMessage, ChatResult, ContentPart, ToolCall, Usage } from './openrouter';

export interface BedrockConnection {
  region: string;
  // Model or inference-profile ids the user can pick.
  models: string[];
}

// Commercial, GovCloud and ISO partitions: us-east-1, eu-west-3,
// ap-southeast-2, us-gov-west-1, ... Anything else is refused, so the key
// can only ever go to bedrock-runtime.<region>.amazonaws.com.
export function isValidRegion(region: unknown): region is string {
  return typeof region === 'string' && /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/.test(region);
}

// Foundation model ids ("anthropic.claude-sonnet-4-5-v1:0"), cross-region
// inference profiles ("us.anthropic..."), and their ARNs.
export function isValidBedrockModelId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9.:_/-]{2,255}$/.test(id) &&
    !id.includes('..') &&
    !id.includes('//') &&
    !/^[a-z]+:\/\//i.test(id)
  );
}

function runtimeBase(region: string): string {
  if (!isValidRegion(region)) throw new Error(`"${region}" isn't a valid AWS region.`);
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

function controlBase(region: string): string {
  if (!isValidRegion(region)) throw new Error(`"${region}" isn't a valid AWS region.`);
  return `https://bedrock.${region}.amazonaws.com`;
}

// ---------- OpenAI-style messages -> Converse ----------

type ConverseBlock =
  | { text: string }
  | { image: { format: string; source: { bytes: string } } }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: { text: string }[]; status: 'success' | 'error' } };

interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ConverseBlock[];
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/i;

function partsToBlocks(content: string | ContentPart[] | null): ConverseBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return content.trim() ? [{ text: content }] : [];
  const blocks: ConverseBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim()) blocks.push({ text: part.text });
    } else {
      const m = IMAGE_DATA_URL.exec(part.image_url.url);
      if (m) blocks.push({ image: { format: m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase(), source: { bytes: m[2] } } });
    }
  }
  return blocks;
}

function parseArgs(json: string): unknown {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {}; // Converse needs an object; a malformed call shows up as a tool error next turn
  }
}

export interface ConverseRequest {
  messages: ConverseMessage[];
  system?: { text: string }[];
  inferenceConfig?: { maxTokens: number };
  toolConfig?: { tools: { toolSpec: { name: string; description: string; inputSchema: { json: unknown } } }[] };
}

// Converse requires user/assistant alternation, tool results inside a user
// message, and no empty text blocks.
export function toConverseRequest(messages: ChatMessage[], tools?: ToolDefinition[], maxTokens?: number): ConverseRequest {
  const system: { text: string }[] = [];
  const out: ConverseMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: ConverseBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : partsToBlocks(m.content).map((b) => ('text' in b ? b.text : '')).join('\n');
      if (text.trim()) system.push({ text });
    } else if (m.role === 'user') {
      push('user', partsToBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks = partsToBlocks(m.content);
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) } });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool' && m.tool_call_id) {
      const text = typeof m.content === 'string' ? m.content : '';
      push('user', [
        {
          toolResult: {
            toolUseId: m.tool_call_id,
            content: [{ text: text || '(no output)' }],
            status: /^(Error|Stopped)\b/.test(text) ? 'error' : 'success',
          },
        },
      ]);
    }
  }
  // Converse requires the conversation to start with a user message.
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ text: '(continue)' }] });

  const req: ConverseRequest = { messages: out };
  if (system.length) req.system = system;
  if (maxTokens !== undefined) req.inferenceConfig = { maxTokens };
  if (tools?.length) {
    req.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: { name: t.function.name, description: t.function.description, inputSchema: { json: t.function.parameters } },
      })),
    };
  }
  return req;
}

// ---------- Converse -> OpenAI-style result ----------

const STOP_REASONS: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  content_filtered: 'content_filter',
  guardrail_intervened: 'content_filter',
};

export function fromConverseResponse(json: any, modelId: string): ChatResult {
  const blocks: any[] = Array.isArray(json?.output?.message?.content) ? json.output.message.content : [];
  const text = blocks.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('');
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b?.toolUse && typeof b.toolUse.name === 'string')
    .map((b, i) => ({
      id: typeof b.toolUse.toolUseId === 'string' ? b.toolUse.toolUseId : `bedrock_${i}`,
      type: 'function' as const,
      function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) },
    }));
  const message: AssistantMessage = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const u = json?.usage ?? {};
  const usage: Usage = {
    promptTokens: Number(u.inputTokens) || 0,
    completionTokens: Number(u.outputTokens) || 0,
    totalTokens: Number(u.totalTokens) || (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0),
  };
  return { model: modelId, message, usage, finishReason: STOP_REASONS[json?.stopReason] ?? json?.stopReason };
}

// ---------- requests ----------

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

async function errorMessage(res: Response): Promise<string> {
  const data: any = await res.json().catch(() => ({}));
  return data?.message || data?.Message || `HTTP ${res.status}`;
}

export class BedrockHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Stream exceptions arrive as events; map them to the HTTP status the
// same failure would have had, so retry and auth handling stay the same.
const EXCEPTION_STATUS: Record<string, number> = {
  validationException: 400,
  accessDeniedException: 403,
  resourceNotFoundException: 404,
  throttlingException: 429,
  modelStreamErrorException: 424,
  internalServerException: 500,
  serviceUnavailableException: 503,
  modelTimeoutException: 408,
};

// Some models reject streaming, or streaming with tools, with a 400 that
// says so. Those requests are retried once with plain Converse.
const STREAM_UNSUPPORTED = /stream/i;

function converseUrl(conn: Pick<BedrockConnection, 'region'>, modelId: string, stream: boolean): string {
  return `${runtimeBase(conn.region)}/model/${encodeURIComponent(modelId)}/${stream ? 'converse-stream' : 'converse'}`;
}

export async function callBedrock(
  conn: Pick<BedrockConnection, 'region'>,
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: CallOptions,
): Promise<ChatResult> {
  if (!isValidBedrockModelId(modelId)) throw new Error(`"${modelId}" isn't a valid Bedrock model id.`);
  const body = JSON.stringify(toConverseRequest(messages, tools, options?.maxTokens));
  const res = await fetch(converseUrl(conn, modelId, true), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: options?.signal,
  });
  if (!res.ok) {
    const msg = await errorMessage(res);
    if (res.status === 400 && STREAM_UNSUPPORTED.test(msg)) return callBedrockWhole(conn, apiKey, modelId, body, options);
    throw new BedrockHttpError(msg, res.status);
  }
  if (!res.body) throw new Error('Bedrock response had no body to stream.');
  return readConverseStream(res.body, modelId, options);
}

// Plain Converse: the whole reply at once.
async function callBedrockWhole(
  conn: Pick<BedrockConnection, 'region'>,
  apiKey: string,
  modelId: string,
  body: string,
  options?: CallOptions,
): Promise<ChatResult> {
  const res = await fetch(converseUrl(conn, modelId, false), { method: 'POST', headers: headers(apiKey), body, signal: options?.signal });
  if (!res.ok) throw new BedrockHttpError(await errorMessage(res), res.status);
  const result = fromConverseResponse(await res.json(), modelId);
  if (result.message.content) options?.onDelta?.(result.message.content);
  return result;
}

// Reads ConverseStream events: text deltas go to onDelta as they arrive,
// tool-call input JSON is collected per content block, and the result has
// the same shape as fromConverseResponse's.
export async function readConverseStream(stream: ReadableStream<Uint8Array>, modelId: string, options?: CallOptions): Promise<ChatResult> {
  const decoder = new EventStreamDecoder();
  const json = new TextDecoder();
  let text = '';
  let stopReason: string | undefined;
  let usage: any = {};
  const toolBlocks = new Map<number, { id?: string; name?: string; input: string }>();
  let sawStop = false;

  const handle = (headers: Record<string, unknown>, payload: Uint8Array) => {
    const type = headers[':message-type'];
    let data: any = {};
    try {
      data = payload.length ? JSON.parse(json.decode(payload)) : {};
    } catch {
      data = {};
    }
    if (type === 'exception') {
      const name = String(headers[':exception-type'] ?? 'exception');
      throw new BedrockHttpError(data?.message || data?.Message || name, EXCEPTION_STATUS[name] ?? 500);
    }
    if (type === 'error') {
      throw new BedrockHttpError(String(headers[':error-message'] ?? headers[':error-code'] ?? 'Bedrock stream error'), 500);
    }
    const index = Number(data?.contentBlockIndex);
    switch (headers[':event-type']) {
      case 'contentBlockStart': {
        const tu = data?.start?.toolUse;
        if (tu && Number.isInteger(index)) toolBlocks.set(index, { id: tu.toolUseId, name: tu.name, input: '' });
        break;
      }
      case 'contentBlockDelta': {
        const d = data?.delta;
        if (typeof d?.text === 'string' && d.text) {
          text += d.text;
          options?.onDelta?.(d.text);
        } else if (typeof d?.toolUse?.input === 'string') {
          const block = toolBlocks.get(index);
          if (block) block.input += d.toolUse.input;
        }
        // reasoningContent deltas (model thinking) aren't shown.
        break;
      }
      case 'messageStop':
        sawStop = true;
        stopReason = data?.stopReason;
        break;
      case 'metadata':
        usage = data?.usage ?? {};
        break;
    }
  };

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of decoder.push(value)) handle(m.headers, m.payload);
    }
  } finally {
    reader.releaseLock();
  }
  if (decoder.pending || (!sawStop && !text && !toolBlocks.size)) {
    throw new BedrockHttpError('The Bedrock stream ended early.', 502);
  }

  const toolCalls: ToolCall[] = [...toolBlocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, b]) => typeof b.name === 'string')
    .map(([i, b]) => ({
      id: typeof b.id === 'string' ? b.id : `bedrock_${i}`,
      type: 'function' as const,
      // Converse sends no input fragments for a tool with no arguments.
      function: { name: b.name as string, arguments: b.input || '{}' },
    }));
  const message: AssistantMessage = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const result: Usage = {
    promptTokens: Number(usage.inputTokens) || 0,
    completionTokens: Number(usage.outputTokens) || 0,
    totalTokens: Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0),
  };
  return { model: modelId, message, usage: result, finishReason: stopReason ? (STOP_REASONS[stopReason] ?? stopReason) : undefined };
}

// Best-effort list of models and inference profiles the key can see.
// Returns [] when listing isn't allowed (the user then types model ids).
export async function listBedrockModels(region: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const ids = new Set<string>();
  const get = async (path: string) => {
    try {
      const res = await fetchImpl(`${controlBase(region)}${path}`, { headers: headers(apiKey), signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const profiles: any = await get('/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000');
  for (const p of profiles?.inferenceProfileSummaries ?? []) {
    if (isValidBedrockModelId(p?.inferenceProfileId)) ids.add(p.inferenceProfileId);
  }
  const models: any = await get('/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND');
  for (const m of models?.modelSummaries ?? []) {
    if (isValidBedrockModelId(m?.modelId)) ids.add(m.modelId);
  }
  return [...ids].sort();
}

// Checks region, key and model with a tiny request. Returns an error
// message, or undefined when they work.
export async function verifyBedrock(region: string, apiKey: string, modelId: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${runtimeBase(region)}/model/${encodeURIComponent(modelId)}/converse`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'ping' }] }], inferenceConfig: { maxTokens: 16 } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return undefined;
    const msg = await errorMessage(res);
    if (res.status === 401 || res.status === 403) return `AWS rejected the key or it lacks access to this model (${msg}).`;
    if (res.status === 404 || /not found|isn't supported|on-demand throughput/i.test(msg)) {
      return `Model "${modelId}" isn't available like this in ${region} (${msg}). Newer models often need an inference profile id such as "us.<model id>".`;
    }
    return `Bedrock returned an error: ${msg}`;
  } catch (err: any) {
    return `Couldn't reach Bedrock: ${err?.message ?? String(err)}`;
  }
}
