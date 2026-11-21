// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// How long a reply each model can write. Replies used to be capped at a
// flat 8,192 tokens; now each model gets its own maximum output, read from
// OpenRouter's public model list (no API key, same host Rizo already
// talks to). If OpenRouter says the account can only afford fewer tokens,
// openrouter.ts retries with what it can afford (parseAffordableTokens).

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
// Used when a model isn't in the list or the list can't be fetched.
export const FALLBACK_MAX_OUTPUT_TOKENS = 32_000;
// Below this, a reply is too short to be useful; tell the user instead.
export const MIN_USEFUL_OUTPUT_TOKENS = 1_024;
const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

// OpenRouter's 402 message: "... You requested up to 64000 tokens, but can
// only afford 1234. ..."
export function parseAffordableTokens(message: string): number | undefined {
  const m = /can only afford (\d+)/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

// { data: [{ id, top_provider: { max_completion_tokens } }] } -> id -> limit
export function parseModelOutputLimits(json: unknown): Map<string, number> {
  const limits = new Map<string, number>();
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return limits;
  for (const m of data) {
    const id = m?.id;
    const max = m?.top_provider?.max_completion_tokens;
    if (typeof id === 'string' && typeof max === 'number' && max > 0) limits.set(id, max);
  }
  return limits;
}

let cache: { fetchedAt: number; limits: Map<string, number> } | undefined;
let inflight: Promise<Map<string, number> | undefined> | undefined;

async function loadLimits(fetchImpl: typeof fetch): Promise<Map<string, number> | undefined> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.limits;
  inflight ??= (async () => {
    try {
      const res = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return cache?.limits;
      const limits = parseModelOutputLimits(await res.json());
      if (limits.size) cache = { fetchedAt: Date.now(), limits };
      return limits.size ? limits : cache?.limits;
    } catch {
      return cache?.limits; // offline or slow: fall back to the last list, or none
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

// The model's maximum output, or undefined if unknown (callers then use
// FALLBACK_MAX_OUTPUT_TOKENS). Never throws.
export async function getMaxOutputTokens(model: string, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  const limits = await loadLimits(fetchImpl);
  // ":free" variants share the base model's limit when not listed separately.
  return limits?.get(model) ?? limits?.get(model.replace(/:free$/, ''));
}

export function resetModelLimitsCacheForTests(): void {
  cache = undefined;
  inflight = undefined;
}
