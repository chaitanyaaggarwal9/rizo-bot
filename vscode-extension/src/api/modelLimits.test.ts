// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMaxOutputTokens, parseAffordableTokens, parseModelOutputLimits, resetModelLimitsCacheForTests } from './modelLimits';

afterEach(() => resetModelLimitsCacheForTests());

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

describe('parseModelOutputLimits', () => {
  it('keeps models with a numeric limit and ignores the rest', () => {
    const limits = parseModelOutputLimits(list);
    expect(limits.get('anthropic/claude-sonnet-5.5')).toBe(128000);
    expect(limits.has('no/limit')).toBe(false);
    expect(limits.size).toBe(2);
    expect(parseModelOutputLimits({}).size).toBe(0);
    expect(parseModelOutputLimits(null).size).toBe(0);
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
