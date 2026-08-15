// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { ToolDefinition } from './tools';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Leaving max_tokens unset lets it default to the model's max (65536 for
// Sonnet 5), which OpenRouter rejects outright on a low-credit account
// ("requires more credits... upgrade to a paid account") since it won't
// risk a completion it can't guarantee you can afford. A modest explicit
// cap keeps normal chat replies working on any balance.
const MAX_TOKENS = 2048;

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') continue;

      let chunk: any;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        continue; // skip one malformed chunk rather than aborting the whole stream
      }

      if (chunk.model) finalModel = chunk.model;
      if (chunk.usage) usage = extractUsage(chunk); // final chunk, when stream_options.include_usage is honored

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

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
    }
  }

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
