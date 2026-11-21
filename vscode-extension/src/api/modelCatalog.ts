// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// OpenRouter's live model list: names, prices, what each model supports,
// and how long a reply it can write. Read from the public endpoint (no API
// key, the same host Rizo already talks to), cached for a few hours, and
// never required: everything that uses it has an offline fallback.
//
// It powers: each model's full reply length (instead of a flat cap), the
// "More models" section of the model switcher (so Rizo doesn't go stale
// when new models ship), live prices, and the Free fallback chain.

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
// Used when a model isn't in the list or the list can't be fetched.
export const FALLBACK_MAX_OUTPUT_TOKENS = 32_000;
// Below this, a reply is too short to be useful; tell the user instead.
export const MIN_USEFUL_OUTPUT_TOKENS = 1_024;
const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface CatalogModel {
  id: string;
  name: string; // "Anthropic: Claude Sonnet 5.5"
  created: number; // unix seconds
  promptPerM: number; // USD per million input tokens
  completionPerM: number; // USD per million output tokens
  contextLength?: number;
  maxOutput?: number;
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
}

// OpenRouter's 402 message: "... You requested up to 64000 tokens, but can
// only afford 1234. ..."
export function parseAffordableTokens(message: string): number | undefined {
  const m = /can only afford (\d+)/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

function perMillion(perToken: unknown): number {
  const n = Number(perToken);
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0;
}

// { data: [...] } -> id -> CatalogModel. Entries missing an id are skipped.
export function parseCatalog(json: unknown): Map<string, CatalogModel> {
  const out = new Map<string, CatalogModel>();
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    if (!m || typeof m.id !== 'string') continue;
    const params: unknown[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const inputs: unknown[] = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
    const maxOutput = m.top_provider?.max_completion_tokens;
    out.set(m.id, {
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      created: typeof m.created === 'number' ? m.created : 0,
      promptPerM: perMillion(m.pricing?.prompt),
      completionPerM: perMillion(m.pricing?.completion),
      contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
      maxOutput: typeof maxOutput === 'number' && maxOutput > 0 ? maxOutput : undefined,
      tools: params.includes('tools'),
      reasoning: params.includes('reasoning'),
      vision: inputs.includes('image'),
    });
  }
  return out;
}

let cache: { fetchedAt: number; models: Map<string, CatalogModel> } | undefined;
let inflight: Promise<Map<string, CatalogModel> | undefined> | undefined;

// The live catalog, or undefined if it has never loaded (offline). Never throws.
export async function getCatalog(fetchImpl: typeof fetch = fetch): Promise<Map<string, CatalogModel> | undefined> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.models;
  inflight ??= (async () => {
    try {
      const res = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return cache?.models;
      const models = parseCatalog(await res.json());
      if (models.size) cache = { fetchedAt: Date.now(), models };
      return models.size ? models : cache?.models;
    } catch {
      return cache?.models; // offline or slow: the last list, or none
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

// Whatever has already loaded, without waiting. For synchronous checks.
export function getCachedCatalog(): Map<string, CatalogModel> | undefined {
  return cache?.models;
}

// The model's maximum output, or undefined if unknown. Never throws.
export async function getMaxOutputTokens(model: string, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  const models = await getCatalog(fetchImpl);
  // ":free" variants share the base model's limit when not listed separately.
  return (models?.get(model) ?? models?.get(model.replace(/:free$/, '')))?.maxOutput;
}

// "Anthropic: Claude Sonnet 5.5" -> "Claude Sonnet 5.5"
export function shortModelName(m: Pick<CatalogModel, 'name' | 'id'>): string {
  const i = m.name.indexOf(': ');
  return i > 0 ? m.name.slice(i + 2) : m.name || m.id;
}

export function formatPrice(m: Pick<CatalogModel, 'promptPerM' | 'completionPerM'>): string {
  if (!m.promptPerM && !m.completionPerM) return 'Free';
  const f = (n: number) => (n >= 1 ? n.toFixed(2) : n.toFixed(n >= 0.1 ? 2 : 3)).replace(/\.?0+$/, '');
  return `$${f(m.promptPerM)} / $${f(m.completionPerM)} per M tok`;
}

export function resetCatalogCacheForTests(): void {
  cache = undefined;
  inflight = undefined;
}
