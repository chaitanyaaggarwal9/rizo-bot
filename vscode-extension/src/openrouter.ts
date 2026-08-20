// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { ToolDefinition } from './tools';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Leaving max_tokens unset lets it default to the model's max (65536 for
// Sonnet 5), which OpenRouter rejects outright on a low-credit account
// ("requires more credits... upgrade to a paid account") since it won't
// risk a completion it can't guarantee you can afford. Needs an explicit
// cap either way — the real tradeoff is where.
//
// 2026-08-20: real incident — a write_file call for a genuinely large
// file (a game engine class, several hundred lines) hit the old 2048
// cap mid-string, every time, on every retry: "Unterminated string in
// JSON" from tools.ts's own parser, a "(unknown path)" tool card
// (summarizeToolCall's title-extraction failed on the same truncated
// JSON), and the model just regenerating the whole thing from scratch
// each retry — one turn alone hit 583K tokens without ever finishing.
// Truncation is a strictly worse failure than the low-credit rejection
// this constant exists to avoid: that one is at least a clear, one-time
// error the user can act on (add credit); silent mid-JSON truncation
// looks like a confusing parser bug and burns a full regeneration on
// every retry with no way to self-correct. Raised 4x — still a bounded,
// affordable worst case even on the priciest model in the catalog
// (8192 * $60/M completion = ~$0.49/call, Opus 5) — rather than raise
// it further and risk that rejection becoming the common case instead.
const MAX_TOKENS = 8192;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// OpenAI-compatible multipart content, for messages that carry an image
// attachment alongside (or instead of) plain text. A message's content is
// either a plain string (the common case) or an array of these parts.
export interface TextContentPart {
  type: 'text';
  text: string;
}
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = TextContentPart | ImageContentPart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  model: string;
  message: AssistantMessage;
  usage: Usage;
}

function extractUsage(data: any): Usage {
  const u = data?.usage || {};
  return {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    totalTokens: u.total_tokens || 0,
  };
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface CallOptions {
  signal?: AbortSignal;
  // Fired once per streamed text chunk, in order, as it arrives.
  onDelta?: (text: string) => void;
  // callWithFallback only: fired if a model attempt already pushed at
  // least one onDelta chunk before failing, right before it moves on to
  // the next model in the chain — the caller's cue to discard whatever
  // partial text it displayed rather than let a second model's reply get
  // appended onto the first's orphaned fragment.
  onRestart?: () => void;
  // How hard THIS model thinks — the token-cost dial, orthogonal to which
  // model is answering (see providers.ts / chatPanel.ts's effort switcher).
  // OpenRouter's unified `reasoning.effort` field translates this into
  // whatever the underlying provider actually expects (a literal effort
  // enum for OpenAI-style models, a thinking-token budget for
  // Anthropic/Gemini) — one field here covers every provider rather than
  // this file needing to know each one's native shape. Omitted entirely
  // for models that don't support reasoning at all (chatPanel.ts checks
  // ModelVariant.reasoning before setting this) so the request body never
  // carries a field an unsupporting model might reject.
  reasoningEffort?: ReasoningEffort;
}

export async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: CallOptions,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: MAX_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) body.tools = tools;
  if (options?.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    // Error responses aren't streamed — same JSON-body parsing as before.
    const data: any = await response.json().catch(() => ({}));
    const message = data?.error?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  if (!response.body) throw new Error('OpenRouter response had no body to stream.');

  let content = '';
  let finalModel = model;
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // Streamed tool-call arguments arrive as partial JSON string fragments
  // spread across many delta chunks, keyed by array index — reassembled
  // here into complete strings before this function ever returns, so
  // tools.ts's executeTool keeps doing a single JSON.parse exactly as it
  // does today. Nothing downstream needs to know streaming happened.
  const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // The SSE spec allows one logical event's data to be split across
  // several consecutive 'data:' lines — the client is meant to
  // concatenate their values with '\n' between them and only parse once
  // a blank line ends the event. The old code treated every single
  // 'data:' line as a complete, independently-parseable JSON chunk on
  // its own, which happens to work for the common case of one line per
  // event but silently breaks the moment a payload is ever legitimately
  // spread across multiple lines this way (a plausible shape for a large
  // write_file tool call's arguments) — each line alone fails
  // JSON.parse, gets silently discarded, and the accumulated tool-call
  // arguments end up missing a chunk with zero indication anything went
  // wrong, until executeTool's JSON.parse fails on the complete,
  // now-corrupted string much later, having already spent the tokens.
  let dataBuffer = '';

  const processEvent = () => {
    if (!dataBuffer) return;
    const dataStr = dataBuffer;
    dataBuffer = '';
    if (dataStr === '[DONE]') return;

    let chunk: any;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return; // genuinely malformed event (not a framing issue) — skip it
    }

    if (chunk.model) finalModel = chunk.model;
    if (chunk.usage) usage = extractUsage(chunk); // final chunk, when stream_options.include_usage is honored

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      options?.onDelta?.(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const acc = (toolCallAcc[tc.index] ??= { args: '' });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = (acc.name || '') + tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      // Tolerates a trailing \r (CRLF) without treating it as part of
      // the line's content — plain .trim() would also eat meaningful
      // leading/trailing spaces inside a multi-line data value.
      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      buffer = buffer.slice(lineEnd + 1);

      if (line === '') {
        // Blank line: end of this event, per spec — dispatch whatever
        // data lines accumulated (if none did, this is just the blank
        // line SSE uses to separate events, nothing to do).
        processEvent();
        continue;
      }
      if (!line.startsWith('data:')) continue; // 'event:', 'id:', ':' comments, etc. — unused here
      // Spec: strip at most one leading space after the colon, not all
      // leading whitespace — a data value can legitimately start with
      // more of its own.
      const value = line.slice(5).replace(/^ /, '');
      dataBuffer = dataBuffer ? `${dataBuffer}\n${value}` : value;
    }
  }
  processEvent(); // covers a final event with no trailing blank line

  const toolCalls: ToolCall[] = Object.keys(toolCallAcc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => {
      const acc = toolCallAcc[i];
      return { id: acc.id || `call_${i}`, type: 'function' as const, function: { name: acc.name || '', arguments: acc.args } };
    });

  const message: AssistantMessage = {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  return { model: finalModel, message, usage };
}

// Tries each model in the chain in order — used for free-mode routing,
// where any individual free model can 429 or come back empty far more
// often than a paid one. Moves to the next model on any error, on a 429,
// or on an HTTP-200-but-empty reply (no text and no tool call).
export async function callWithFallback(
  apiKey: string,
  chain: string[],
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: CallOptions,
): Promise<ChatResult> {
  let lastError = 'All models in the fallback chain failed';

  for (const model of chain) {
    let deltaFired = false;
    try {
      const result = await callOpenRouter(apiKey, model, messages, tools, {
        signal: options?.signal,
        onDelta: (text) => {
          deltaFired = true;
          options?.onDelta?.(text);
        },
      });
      const hasContent = !!(typeof result.message.content === 'string' && result.message.content.trim());
      const hasToolCalls = !!(result.message.tool_calls && result.message.tool_calls.length > 0);
      if (!hasContent && !hasToolCalls) {
        lastError = `${model} returned an empty reply`;
        if (deltaFired) options?.onRestart?.();
        continue;
      }
      return result;
    } catch (err: any) {
      // A cancelled turn should stop outright, not spend the next model in
      // the chain retrying work nobody asked for anymore.
      if (err.name === 'AbortError') throw err;
      lastError = err.message;
      if (deltaFired) options?.onRestart?.();
    }
  }

  throw new Error(lastError);
}
