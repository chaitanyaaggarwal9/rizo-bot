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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatResult {
  model: string;
  message: AssistantMessage;
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
  return { model: data?.model || model, message };
}
