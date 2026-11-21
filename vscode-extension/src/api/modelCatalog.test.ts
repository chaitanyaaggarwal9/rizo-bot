// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPrice, getCachedCatalog, getCatalog, getMaxOutputTokens, parseAffordableTokens, parseCatalog, resetCatalogCacheForTests, shortModelName } from './modelCatalog';

afterEach(() => resetCatalogCacheForTests());

const full = {
  data: [
    {
      id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', created: 1790000000,
      pricing: { prompt: '0.000002', completion: '0.00001' }, context_length: 1000000,
      top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools', 'reasoning'],
      architecture: { input_modalities: ['text', 'image'] },
    },
    { id: 'openai/gpt-oss-20b', top_provider: { max_completion_tokens: 32768 } },
    { id: 'no/limit', top_provider: { max_completion_tokens: null } },
    { junk: true },
  ],
};
const list = {
  data: [
    { id: 'anthropic/claude-sonnet-5.5', top_provider: { max_completion_tokens: 128000 } },
    { id: 'openai/gpt-oss-20b', top_provider: { max_completion_tokens: 32768 } },
    { id: 'no/limit', top_provider: { max_completion_tokens: null } },
    { junk: true },
  ],
};

describe('parseAffordableTokens', () => {
  it("reads OpenRouter's 402 message", () => {
    expect(
      parseAffordableTokens('This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1234. To increase, visit https://openrouter.ai/settings/credits'),
    ).toBe(1234);
    expect(parseAffordableTokens('Rate limit exceeded')).toBeUndefined();
  });
});

describe('parseCatalog', () => {
  it('reads each model and skips entries without an id', () => {
    const models = parseCatalog(full);
    expect(models.size).toBe(3);
    expect(models.get('anthropic/claude-sonnet-5.5')).toMatchObject({
      name: 'Anthropic: Claude Sonnet 5.5', maxOutput: 128000, tools: true, reasoning: true, vision: true, promptPerM: 2, completionPerM: 10,
    });
    expect(models.get('no/limit')).toMatchObject({ maxOutput: undefined, tools: false, vision: false });
    expect(parseCatalog({}).size).toBe(0);
    expect(parseCatalog(null).size).toBe(0);
  });

  it('formats names and prices for the model switcher', () => {
    const m = parseCatalog(full).get('anthropic/claude-sonnet-5.5')!;
    expect(shortModelName(m)).toBe('Claude Sonnet 5.5');
    expect(formatPrice(m)).toBe('$2 / $10 per M tok');
    expect(formatPrice({ promptPerM: 0.05, completionPerM: 0.2 })).toBe('$0.05 / $0.2 per M tok');
    expect(formatPrice({ promptPerM: 0, completionPerM: 0 })).toBe('Free');
  });
});

describe('getMaxOutputTokens', () => {
  it('fetches the list once and caches it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(list), { status: 200 }));
    expect(await getMaxOutputTokens('anthropic/claude-sonnet-5.5', fetchImpl)).toBe(128000);
    expect(await getMaxOutputTokens('openai/gpt-oss-20b:free', fetchImpl)).toBe(32768);
    expect(await getMaxOutputTokens('unknown/model', fetchImpl)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/models');
  });

  it('returns undefined instead of throwing when offline', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    expect(await getMaxOutputTokens('anthropic/claude-sonnet-5.5', fetchImpl)).toBeUndefined();
  });
});

describe('getCachedCatalog', () => {
  it('is empty until the catalog loads, then returns it without fetching', async () => {
    expect(getCachedCatalog()).toBeUndefined();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(full), { status: 200 }));
    await getCatalog(fetchImpl);
    expect(getCachedCatalog()?.has('anthropic/claude-sonnet-5.5')).toBe(true);
  });
});
