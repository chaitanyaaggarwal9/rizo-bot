// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  PROVIDER_ORDER,
  PROVIDERS,
  defaultModelForProvider,
  effortForTier,
  findVariant,
  isValidProviderModel,
  startingModelForProvider,
  supportsReasoning,
  belongsToProvider,
  modelSupportsVision,
} from './providers';

describe('the provider catalog itself', () => {
  it('every provider in PROVIDER_ORDER exists in PROVIDERS, and vice versa', () => {
    expect(PROVIDER_ORDER.sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it('every provider has at least one variant, ordered cheapest to strongest', () => {
    for (const id of PROVIDER_ORDER) {
      expect(PROVIDERS[id].variants.length).toBeGreaterThan(0);
    }
  });

  it('free is the one provider allowed more than 3 variants, and Auto is always first', () => {
    // Free's variants aren't a cheap-to-strong ladder like every other
    // provider's — see providers.ts's own comment — so it's exempt from
    // the "3 tiers" shape the rest of the catalog holds to. Auto being
    // variants[0] is still load-bearing: defaultModelForProvider and
    // (via the exclusion in chatPanel.ts) Smart Starting Variant both
    // depend on it being the fallback/default.
    expect(PROVIDERS.free.variants.length).toBeGreaterThan(1);
    expect(PROVIDERS.free.variants[0].id).toBe('openrouter/free');
  });

  it('every non-free provider has a 2- or 3-step cheap-to-strong ladder', () => {
    for (const id of PROVIDER_ORDER) {
      if (id === 'free') continue;
      expect(PROVIDERS[id].variants.length).toBeGreaterThanOrEqual(2);
      expect(PROVIDERS[id].variants.length).toBeLessThanOrEqual(3);
    }
  });

  it("every curated variant belongs to its own provider's id family", () => {
    for (const id of PROVIDER_ORDER) {
      for (const v of PROVIDERS[id].variants) expect(belongsToProvider(id, v.id)).toBe(true);
    }
  });
});

describe('defaultModelForProvider', () => {
  it('returns the cheapest (first) variant for a real provider', () => {
    expect(defaultModelForProvider('claude')).toBe(PROVIDERS.claude.variants[0].id);
  });

  it('falls back to Free for an unknown provider id rather than throwing', () => {
    expect(defaultModelForProvider('not-a-real-provider')).toBe(PROVIDERS.free.variants[0].id);
  });
});

describe('startingModelForProvider (Smart Starting Variant)', () => {
  it('maps tier 0/1/2 onto that provider\'s own cheapest/mid/strongest variant', () => {
    expect(startingModelForProvider('claude', 0)).toBe(PROVIDERS.claude.variants[0].id);
    expect(startingModelForProvider('claude', 1)).toBe(PROVIDERS.claude.variants[1].id);
    expect(startingModelForProvider('claude', 2)).toBe(PROVIDERS.claude.variants[2].id);
  });

  it('clamps to the last variant for an out-of-range tier rather than returning undefined', () => {
    expect(startingModelForProvider('claude', 5)).toBe(PROVIDERS.claude.variants[2].id);
  });

  it('never crosses providers — always a variant of the requested company', () => {
    for (const id of PROVIDER_ORDER) {
      for (const tier of [0, 1, 2]) {
        expect(isValidProviderModel(id, startingModelForProvider(id, tier))).toBe(true);
      }
    }
  });
});

describe('isValidProviderModel', () => {
  it('accepts a real variant of the given provider', () => {
    expect(isValidProviderModel('claude', 'anthropic/claude-sonnet-5.5')).toBe(true);
  });

  it('rejects a real model id under the wrong provider (no cross-company leakage)', () => {
    expect(isValidProviderModel('gemini', 'anthropic/claude-sonnet-5.5')).toBe(false);
  });

  it('rejects an unknown model id entirely', () => {
    expect(isValidProviderModel('claude', 'not-a-real-model')).toBe(false);
  });

  it('regression: moonshotai/kimi-k2-turbo (pulled from OpenRouter 2026-08-20) is correctly gone from the catalog', () => {
    // A real user hit "not a valid model ID" from OpenRouter itself on
    // an existing thread already locked to this id — chatPanel.ts's
    // handleSend now self-heals a thread stuck on a since-invalidated
    // model by falling back to defaultModelForProvider; this pins the
    // catalog side of that fix so a future re-add of the same dead id
    // doesn't silently break the fallback's assumption again.
    expect(isValidProviderModel('kimi', 'moonshotai/kimi-k2-turbo')).toBe(false);
    expect(isValidProviderModel('kimi', defaultModelForProvider('kimi'))).toBe(true);
  });
});

describe('findVariant / supportsReasoning', () => {
  it('finds a real variant by id', () => {
    expect(findVariant('claude', 'anthropic/claude-fable-5.2')?.label).toBe('Fable 5.2');
  });

  it('defaults reasoning support to true when unset on the variant', () => {
    expect(supportsReasoning('claude', 'anthropic/claude-sonnet-5.5')).toBe(true);
  });

  it("Free's rotating Auto model explicitly does not support reasoning", () => {
    expect(supportsReasoning('free', PROVIDERS.free.variants[0].id)).toBe(false);
  });

  it('an unrecognized provider/model pair still returns a defined boolean, not throws', () => {
    expect(supportsReasoning('claude', 'nonexistent')).toBe(true); // findVariant returns undefined -> treated as "not explicitly false"
  });

  it("Free's named picks (unlike Auto) all support reasoning, since each is one specific real model", () => {
    for (const v of PROVIDERS.free.variants) {
      if (v.id === 'openrouter/free') continue;
      expect(supportsReasoning('free', v.id)).toBe(true);
    }
  });

  it("Free's Auto router is marked text-only, so images go to a named vision model", () => {
    expect(findVariant('free', 'openrouter/free')?.vision).toBe(false);
    expect(PROVIDERS.free.variants.some((v) => v.vision !== false)).toBe(true);
  });
});

describe('effortForTier (effort auto-suggestion)', () => {
  it('maps tier 0/1/2 onto low/medium/high in order', () => {
    expect(effortForTier(0)).toBe('low');
    expect(effortForTier(1)).toBe('medium');
    expect(effortForTier(2)).toBe('high');
  });

  it('clamps out-of-range tiers instead of returning undefined', () => {
    expect(effortForTier(-1)).toBe('low');
    expect(effortForTier(99)).toBe('high');
  });

  it('every EFFORT_LEVELS entry has exactly one tier that maps to it', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high']);
    expect(DEFAULT_EFFORT).toBe('medium');
  });
});

describe('live catalog models ("More models")', () => {
  const catalog = new Map([
    ['anthropic/claude-opus-5.5', { tools: true, vision: true, reasoning: true }],
    ['anthropic/claude-sonnet-5', { tools: true, vision: true, reasoning: true }],
    ['anthropic/claude-instant-1', { tools: false, vision: false, reasoning: false }],
    ['openai/gpt-6.2-astra', { tools: true, vision: true, reasoning: true }],
    ['deepseek/deepseek-v4-flash', { tools: true, vision: false, reasoning: false }],
    ['baidu/ernie-5.5-flash-preview:free', { tools: true, vision: false, reasoning: true }],
    ['anthropic/claude-sonnet-5.5:batch', { tools: true, vision: true, reasoning: true }],
  ]);

  it('accepts other tool-capable models of the same company', () => {
    expect(isValidProviderModel('claude', 'anthropic/claude-opus-5.5', catalog)).toBe(true);
    expect(isValidProviderModel('claude', 'anthropic/claude-sonnet-5', catalog)).toBe(true);
    expect(isValidProviderModel('free', 'baidu/ernie-5.5-flash-preview:free', catalog)).toBe(true);
  });

  it('rejects other companies, models without tools, batch variants and unknown ids', () => {
    expect(isValidProviderModel('claude', 'openai/gpt-6.2-astra', catalog)).toBe(false);
    expect(isValidProviderModel('claude', 'anthropic/claude-instant-1', catalog)).toBe(false);
    expect(isValidProviderModel('claude', 'anthropic/claude-sonnet-5.5:batch', catalog)).toBe(false);
    expect(isValidProviderModel('claude', 'anthropic/not-real', catalog)).toBe(false);
    expect(isValidProviderModel('openai', 'baidu/ernie-5.5-flash-preview:free', catalog)).toBe(false);
  });

  it('without the catalog only curated variants are valid', () => {
    expect(isValidProviderModel('claude', 'anthropic/claude-opus-5.5')).toBe(false);
  });

  it('uses the catalog for vision and reasoning of non-curated models', () => {
    expect(modelSupportsVision('deepseek', 'deepseek/deepseek-v4-flash', catalog)).toBe(false);
    expect(supportsReasoning('deepseek', 'deepseek/deepseek-v4-flash', catalog)).toBe(false);
    expect(modelSupportsVision('claude', 'anthropic/claude-opus-5.5', catalog)).toBe(true);
    expect(modelSupportsVision('deepseek', 'deepseek/deepseek-v4-pro', catalog)).toBe(false); // curated flag wins
  });

  it('keeps Gemini to Gemini models and Free to free ones', () => {
    expect(belongsToProvider('gemini', 'google/gemini-4-carbon')).toBe(true);
    expect(belongsToProvider('gemini', 'google/gemma-4-26b-a4b-it:free')).toBe(false);
    expect(belongsToProvider('free', 'google/gemma-4-26b-a4b-it:free')).toBe(true);
    expect(belongsToProvider('openai', 'openai/gpt-oss-20b:free')).toBe(false);
  });
});
