// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Azure AI Foundry (and Azure OpenAI): your own Azure deployments, with
// your own key, through Azure's OpenAI-compatible v1 API
// (https://<resource>.openai.azure.com/openai/v1/chat/completions). The
// streaming and parsing are shared with OpenRouter (openrouter.ts); this
// file only knows Azure's URL, auth header and parameter names.
// No 'vscode' import: tested in azure.test.ts.

import { ToolDefinition } from '../tools/tools';
import { CallOptions, ChatMessage, ChatResult, CompletionTarget, OpenRouterHttpError, requestCompletion } from './openrouter';

// Hosts an Azure key may be sent to. Anything else is refused, so a typo
// or a malicious value can't send your key to someone else's server.
const AZURE_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i;

export interface AzureConnection {
  // Normalized base URL, always "https://<host>/openai/v1".
  baseUrl: string;
  // Deployment names the user can pick (sent as `model`).
  deployments: string[];
}

// Accepts what people paste from the Azure portal: with or without
// https://, with or without a trailing /openai/v1 or other path. Returns
// the v1 base URL, or an error message.
export function normalizeAzureEndpoint(input: string): { baseUrl: string } | { error: string } {
  const raw = (input || '').trim();
  if (!raw) return { error: 'Enter your Azure endpoint, for example https://my-resource.openai.azure.com' };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: "That isn't a valid URL." };
  }
  if (url.protocol !== 'https:') return { error: 'The endpoint must use https.' };
  if (url.username || url.password) return { error: "The endpoint can't contain a username or password." };
  if (url.port) return { error: "The endpoint can't use a custom port." };
  if (!AZURE_HOST.test(url.hostname)) {
    return {
      error:
        'Use your Azure resource endpoint, ending in .openai.azure.com, .services.ai.azure.com or .cognitiveservices.azure.com.',
    };
  }
  return { baseUrl: `https://${url.hostname.toLowerCase()}/openai/v1` };
}

// A deployment name as Azure allows it (letters, digits, - _ .). Also what
// the chat view may send as a model id for an Azure chat.
export function isValidDeploymentName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

function azureHeaders(apiKey: string): Record<string, string> {
  // Azure's docs show both forms for keys on the v1 API; sending both
  // works with either.
  return { 'api-key': apiKey, Authorization: `Bearer ${apiKey}` };
}

// Best-effort list of model/deployment ids from GET /openai/v1/models.
// Returns [] when the endpoint doesn't list them (the user then types
// deployment names).
export async function listAzureModels(conn: Pick<AzureConnection, 'baseUrl'>, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${conn.baseUrl}/models`, {
      headers: azureHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const ids = Array.isArray(json?.data) ? json.data.map((m: any) => m?.id).filter(isValidDeploymentName) : [];
    return [...new Set<string>(ids)].sort();
  } catch {
    return [];
  }
}

// Checks the endpoint and key with a tiny request. Returns an error
// message, or undefined when they work.
export async function verifyAzureConnection(
  conn: Pick<AzureConnection, 'baseUrl'>,
  apiKey: string,
  deployment: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${conn.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...azureHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: deployment, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 16 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return undefined;
    const data: any = await res.json().catch(() => ({}));
    const msg = data?.error?.message || `HTTP ${res.status}`;
    // A parameter complaint still proves the endpoint, key and deployment work.
    if (res.status === 400 && /max_completion_tokens|max_tokens|unsupported/i.test(msg)) return undefined;
    if (res.status === 401 || res.status === 403) return `Azure rejected the key (${msg}).`;
    if (res.status === 404) return `Azure couldn't find deployment "${deployment}" at this endpoint (${msg}).`;
    return `Azure returned an error: ${msg}`;
  } catch (err: any) {
    return `Couldn't reach Azure: ${err?.message ?? String(err)}`;
  }
}

interface AzureShape {
  // Newer (reasoning) models require max_completion_tokens; some older
  // deployments only know max_tokens.
  maxField: 'max_completion_tokens' | 'max_tokens';
  includeUsage: boolean;
  sendEffort: boolean;
}

function azureTarget(conn: AzureConnection, apiKey: string, shape: AzureShape): CompletionTarget {
  return {
    url: `${conn.baseUrl}/chat/completions`,
    headers: azureHeaders(apiKey),
    label: 'Azure',
    shapeBody: (body, options) => {
      const out: Record<string, unknown> = { ...body };
      if ('max_tokens' in out && shape.maxField === 'max_completion_tokens') {
        out.max_completion_tokens = out.max_tokens;
        delete out.max_tokens;
      }
      if (!shape.includeUsage) delete out.stream_options;
      if (shape.sendEffort && options?.reasoningEffort) out.reasoning_effort = options.reasoningEffort;
      return out;
    },
  };
}

// One chat turn against an Azure deployment. Different deployments accept
// different parameters, so a 400 naming one of them is retried without
// it (at most once per parameter). No output cap is sent unless the user
// set rizo.limits.maxOutputTokens: Azure bills its own way and has no
// "can only afford" limit to work around.
export async function callAzure(
  conn: AzureConnection,
  apiKey: string,
  deployment: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: CallOptions,
): Promise<ChatResult> {
  const shape: AzureShape = { maxField: 'max_completion_tokens', includeUsage: true, sendEffort: true };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await requestCompletion(azureTarget(conn, apiKey, shape), deployment, messages, tools, options, options?.maxTokens);
    } catch (err) {
      if (!(err instanceof OpenRouterHttpError) || err.status !== 400) throw err;
      const m = err.message;
      if (shape.maxField === 'max_completion_tokens' && /max_completion_tokens/i.test(m)) shape.maxField = 'max_tokens';
      else if (shape.includeUsage && /stream_options|include_usage/i.test(m)) shape.includeUsage = false;
      else if (shape.sendEffort && options?.reasoningEffort && /reasoning_effort|reasoning/i.test(m)) shape.sendEffort = false;
      else throw err;
    }
  }
  throw new Error('Azure rejected the request.');
}
