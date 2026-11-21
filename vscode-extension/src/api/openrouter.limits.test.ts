// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenRouter, callWithFallback } from './openrouter';
import { FALLBACK_MAX_OUTPUT_TOKENS } from './modelCatalog';

function okStream(text = 'done'): Response {
  const body = [
    'data: ' + JSON.stringify({ model: 'm', choices: [{ delta: { content: text } }] }),
    '',
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '',
  ].map((l) => l + '\n').join('');
  return new Response(new TextEncoder().encode(body), { status: 200 });
}
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}
const sentMaxTokens = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).max_tokens);
const msgs = [{ role: 'user' as const, content: 'hi' }];

afterEach(() => vi.unstubAllGlobals());

describe('reply length', () => {
  it("asks for the model's own maximum", async () => {
    const f = vi.fn().mockResolvedValue(okStream());
    vi.stubGlobal('fetch', f);
    await callOpenRouter('k', 'a/model', msgs, undefined, { maxTokensFor: async () => 128000 });
    expect(sentMaxTokens(f)).toEqual([128000]);
  });

  it('uses the fallback when the limit is unknown, and an explicit cap when set', async () => {
    const f = vi.fn().mockImplementation(async () => okStream());
    vi.stubGlobal('fetch', f);
    await callOpenRouter('k', 'a/model', msgs, undefined, { maxTokensFor: async () => undefined });
    await callOpenRouter('k', 'a/model', msgs, undefined, { maxTokens: 4000, maxTokensFor: async () => 128000 });
    expect(sentMaxTokens(f)).toEqual([FALLBACK_MAX_OUTPUT_TOKENS, 4000]);
  });

  it('retries with what the account can afford', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(402, 'You requested up to 128000 tokens, but can only afford 20000.'))
      .mockResolvedValueOnce(okStream('ok'));
    vi.stubGlobal('fetch', f);
    const r = await callOpenRouter('k', 'a/model', msgs, undefined, { maxTokensFor: async () => 128000 });
    expect(r.message.content).toBe('ok');
    expect(sentMaxTokens(f)).toEqual([128000, 19000]);
  });

  it('explains when the credit covers too little to be useful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(402, 'You requested up to 128000 tokens, but can only afford 300.')));
    await expect(callOpenRouter('k', 'a/model', msgs, undefined, { maxTokensFor: async () => 128000 })).rejects.toThrow(
      /only covers about 300 more tokens.*openrouter\.ai\/settings\/credits/,
    );
  });

  it('falls back to 8,192 when a provider rejects the requested max_tokens', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(400, 'max_tokens: 128000 > 64000, which is the maximum allowed'))
      .mockResolvedValueOnce(okStream());
    vi.stubGlobal('fetch', f);
    await callOpenRouter('k', 'a/model', msgs, undefined, { maxTokensFor: async () => 128000 });
    expect(sentMaxTokens(f)).toEqual([128000, 8192]);
  });

  it('does not retry unrelated errors', async () => {
    const f = vi.fn().mockResolvedValue(errorResponse(429, 'Rate limit exceeded'));
    vi.stubGlobal('fetch', f);
    await expect(callOpenRouter('k', 'a/model', msgs)).rejects.toThrow('Rate limit exceeded');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('callWithFallback', () => {
  it('passes Effort and the output cap to Free models', async () => {
    const f = vi.fn().mockResolvedValue(okStream());
    vi.stubGlobal('fetch', f);
    await callWithFallback('k', ['free/model:free'], msgs, undefined, { reasoningEffort: 'high', maxTokens: 5000 });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.max_tokens).toBe(5000);
  });
});

describe('cost reporting', () => {
  it('asks OpenRouter for the cost and returns it with the usage', async () => {
    const body = [
      'data: ' + JSON.stringify({ model: 'm', choices: [{ delta: { content: 'hi' } }] }),
      '',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00042 } }),
      '',
    ].map((l) => l + '\n').join('');
    const f = vi.fn().mockResolvedValue(new Response(new TextEncoder().encode(body), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const r = await callOpenRouter('k', 'a/model', msgs);
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).usage).toEqual({ include: true });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.00042 });
  });
});

