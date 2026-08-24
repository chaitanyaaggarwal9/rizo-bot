// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { ToolDefinition } from './tools';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Leaving max_tokens unset defaults to the model's max, which OpenRouter
// rejects outright on a low-credit account. Needs an explicit cap either
// way.
//
// Truncation is a strictly worse failure than that rejection: a cut-off
// write_file call mid-JSON fails to parse, the model regenerates from
// scratch each retry with no way to self-correct, and a turn can burn
// hundreds of thousands of tokens without finishing. Raised from 2048 to
// 8192 — still a bounded, affordable worst case even on the priciest
// model in the catalog (~$0.49/call, Opus 5) — rather than risk the
// rejection becoming the common case instead.
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
  // 'length' means the completion was cut off by max_tokens, not a
  // model-chosen stop — chatPanel.ts uses this to give truncation-specific
  // guidance instead of a generic parse error. Undefined (not required)
  // since a provider that omits it shouldn't be forced to fake one.
  finishReason?: string;
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
  // callWithFallback only: fired when a failed attempt already streamed
  // some text, right before moving to the next model — the caller's cue
  // to discard the partial text.
  onRestart?: () => void;
  // How hard this model thinks — orthogonal to which model answers.
  // OpenRouter's unified `reasoning.effort` field translates this into
  // whatever the underlying provider expects. Omitted for models that
  // don't support reasoning (chatPanel.ts checks ModelVariant.reasoning)
  // so the body never carries a field an unsupporting model might reject.
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
  let finishReason: string | undefined;
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // Streamed tool-call arguments arrive as partial JSON fragments across
  // many delta chunks, keyed by array index — reassembled here into
  // complete strings so executeTool keeps doing one JSON.parse. Nothing
  // downstream needs to know streaming happened.
  const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // The SSE spec allows one event's data to span several consecutive
  // 'data:' lines, concatenated with '\n' and parsed only once a blank
  // line ends the event. Treating each 'data:' line as independently
  // parseable breaks the moment a payload spans multiple lines (plausible
  // for a large write_file call) — each line alone fails JSON.parse and
  // gets silently discarded, corrupting the accumulated tool-call
  // arguments with no indication anything went wrong.
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
    // finish_reason arrives on the terminal chunk, often alongside an
    // empty delta — read unconditionally here, not inside the `if
    // (!delta) return` guard below, so a finish-reason-only chunk isn't
    // missed.
    const reason = chunk.choices?.[0]?.finish_reason;
    if (reason) finishReason = reason;

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
  return { model: finalModel, message, usage, finishReason };
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
