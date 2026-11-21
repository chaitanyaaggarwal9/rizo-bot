// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { FREE_MODELS, freeChainForTaskType } from './freeModels';

describe('freeChainForTaskType', () => {
  it("returns the coding-ranked list plus the fallback, for 'coding'", () => {
    expect(freeChainForTaskType('coding')).toEqual([...FREE_MODELS.coding, FREE_MODELS.fallback]);
  });

  it("returns the general-ranked list plus the fallback, for 'general'", () => {
    expect(freeChainForTaskType('general')).toEqual([...FREE_MODELS.general, FREE_MODELS.fallback]);
  });

  it('always ends with the always-answers fallback model', () => {
    expect(freeChainForTaskType('coding').at(-1)).toBe('openrouter/free');
    expect(freeChainForTaskType('general').at(-1)).toBe('openrouter/free');
  });

  it('never returns an empty chain', () => {
    expect(freeChainForTaskType('coding').length).toBeGreaterThan(0);
    expect(freeChainForTaskType('general').length).toBeGreaterThan(0);
  });
});
