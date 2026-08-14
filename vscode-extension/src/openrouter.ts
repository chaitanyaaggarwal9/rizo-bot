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

export async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<ChatResult> {
  const body: Record<string, unknown> = { model, messages, max_tokens: MAX_TOKENS };
  if (tools && tools.length) body.tools = tools;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }

  const message: AssistantMessage = data?.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  return { model: data?.model || model, message, usage: extractUsage(data) };
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
): Promise<ChatResult> {
  let lastError = 'All models in the fallback chain failed';

  for (const model of chain) {
    try {
      const result = await callOpenRouter(apiKey, model, messages, tools);
      const hasContent = !!(typeof result.message.content === 'string' && result.message.content.trim());
      const hasToolCalls = !!(result.message.tool_calls && result.message.tool_calls.length > 0);
      if (!hasContent && !hasToolCalls) {
        lastError = `${model} returned an empty reply`;
        continue;
      }
      return result;
    } catch (err: any) {
      lastError = err.message;
    }
  }

  throw new Error(lastError);
}
