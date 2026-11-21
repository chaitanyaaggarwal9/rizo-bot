// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { estimateCost } from './pricing';

describe('estimateCost', () => {
  it('is always $0 for a free-tier (":free") model regardless of token counts', () => {
    expect(estimateCost('poolside/laguna-s-2.1:free', 1_000_000, 1_000_000)).toBe(0);
  });

  it("is always $0 for OpenRouter's own free router", () => {
    expect(estimateCost('openrouter/free', 500_000, 500_000)).toBe(0);
  });

  it('computes prompt + completion cost correctly for a known paid model', () => {
    // Haiku 4.5: $0.25/M prompt, $1.25/M completion.
    const cost = estimateCost('anthropic/claude-haiku-4.5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.25 + 1.25, 6);
  });

  it('scales linearly with token count, not just a flat per-call rate', () => {
    const half = estimateCost('anthropic/claude-sonnet-5', 500_000, 0);
    const full = estimateCost('anthropic/claude-sonnet-5', 1_000_000, 0);
    expect(full).toBeCloseTo(half * 2, 6);
  });

  it('returns 0 rather than throwing for a model id not in the pricing table', () => {
    expect(estimateCost('some-unknown-model', 100_000, 100_000)).toBe(0);
  });

  it('prompt and completion tokens are priced independently, not averaged', () => {
    // Opus 5: $12/M prompt, $60/M completion — completion is 5x pricier.
    const promptOnly = estimateCost('anthropic/claude-opus-5', 1_000_000, 0);
    const completionOnly = estimateCost('anthropic/claude-opus-5', 0, 1_000_000);
    expect(completionOnly).toBeCloseTo(promptOnly * 5, 6);
  });
});
