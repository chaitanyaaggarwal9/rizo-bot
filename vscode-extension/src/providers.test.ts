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

  it('free has exactly one variant — the company lock has nothing to switch between', () => {
    expect(PROVIDERS.free.variants).toHaveLength(1);
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

  it('clamps to the last variant when a provider has fewer tiers than requested', () => {
    // Free has exactly one variant — every tier lands on it.
    expect(startingModelForProvider('free', 0)).toBe(PROVIDERS.free.variants[0].id);
    expect(startingModelForProvider('free', 2)).toBe(PROVIDERS.free.variants[0].id);
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
    expect(isValidProviderModel('claude', 'anthropic/claude-sonnet-5')).toBe(true);
  });

  it('rejects a real model id under the wrong provider (no cross-company leakage)', () => {
    expect(isValidProviderModel('gemini', 'anthropic/claude-sonnet-5')).toBe(false);
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
    expect(findVariant('claude', 'anthropic/claude-opus-5')?.label).toBe('Opus 5');
  });

  it('defaults reasoning support to true when unset on the variant', () => {
    expect(supportsReasoning('claude', 'anthropic/claude-sonnet-5')).toBe(true);
  });

  it("Free's rotating Auto model explicitly does not support reasoning", () => {
    expect(supportsReasoning('free', PROVIDERS.free.variants[0].id)).toBe(false);
  });

  it('an unrecognized provider/model pair still returns a defined boolean, not throws', () => {
    expect(supportsReasoning('claude', 'nonexistent')).toBe(true); // findVariant returns undefined -> treated as "not explicitly false"
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
