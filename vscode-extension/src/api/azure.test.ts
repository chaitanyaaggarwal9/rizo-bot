// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAzure, isValidDeploymentName, listAzureModels, normalizeAzureEndpoint, verifyAzureConnection } from './azure';

afterEach(() => vi.unstubAllGlobals());

const conn = { baseUrl: 'https://my-res.openai.azure.com/openai/v1', deployments: ['gpt-5-chat'] };
const msgs = [{ role: 'user' as const, content: 'hi' }];

function okStream(text = 'done'): Response {
  const body = [
    'data: ' + JSON.stringify({ model: 'gpt-5-chat', choices: [{ delta: { content: text } }] }),
    '',
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    '',
  ].map((l) => l + '\n').join('');
  return new Response(new TextEncoder().encode(body), { status: 200 });
}
const err400 = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 400 });
const bodies = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));

describe('normalizeAzureEndpoint', () => {
  it('accepts portal endpoints in any common form and returns the v1 base', () => {
    for (const input of [
      'https://my-res.openai.azure.com',
      'https://my-res.openai.azure.com/',
      'my-res.openai.azure.com',
      'https://my-res.openai.azure.com/openai/v1/',
      'https://MY-RES.openai.azure.com/openai/deployments/x/chat/completions?api-version=2024-10-21',
    ]) {
      expect(normalizeAzureEndpoint(input)).toEqual({ baseUrl: 'https://my-res.openai.azure.com/openai/v1' });
    }
    expect(normalizeAzureEndpoint('https://proj.services.ai.azure.com')).toEqual({ baseUrl: 'https://proj.services.ai.azure.com/openai/v1' });
    expect(normalizeAzureEndpoint('https://r.cognitiveservices.azure.com')).toEqual({ baseUrl: 'https://r.cognitiveservices.azure.com/openai/v1' });
  });

  it('refuses anything that could send the key somewhere else', () => {
    for (const input of [
      '',
      'http://my-res.openai.azure.com',
      'https://evil.com',
      'https://my-res.openai.azure.com.evil.com',
      'https://evil.com/my-res.openai.azure.com',
      'https://user:pw@my-res.openai.azure.com',
      'https://my-res.openai.azure.com:8443',
      'https://a.b.openai.azure.com',
      'javascript:alert(1)',
    ]) {
      expect(normalizeAzureEndpoint(input)).toHaveProperty('error');
    }
  });
});

describe('isValidDeploymentName', () => {
  it('accepts Azure deployment names and rejects anything else', () => {
    for (const ok of ['gpt-5-chat', 'DeepSeek-R1', 'my_model.v2']) expect(isValidDeploymentName(ok)).toBe(true);
    for (const bad of ['', '../x', 'a b', '-lead', 'x'.repeat(65), 42, null]) expect(isValidDeploymentName(bad)).toBe(false);
  });
});

describe('callAzure', () => {
  it('posts to the v1 chat completions URL with the key and Azure parameter names', async () => {
    const f = vi.fn().mockResolvedValue(okStream('hello'));
    vi.stubGlobal('fetch', f);
    const r = await callAzure(conn, 'k3y', 'gpt-5-chat', msgs, undefined, { reasoningEffort: 'high', maxTokens: 900 });
    expect(r.message.content).toBe('hello');
    expect(r.usage.totalTokens).toBe(5);
    expect(f.mock.calls[0][0]).toBe('https://my-res.openai.azure.com/openai/v1/chat/completions');
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['api-key']).toBe('k3y');
    expect(headers.Authorization).toBe('Bearer k3y');
    const [body] = bodies(f);
    expect(body).toMatchObject({ model: 'gpt-5-chat', stream: true, max_completion_tokens: 900, reasoning_effort: 'high' });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('usage'); // OpenRouter-only
    expect(body).not.toHaveProperty('reasoning');
  });

  it('sends no output cap unless the user set one', async () => {
    const f = vi.fn().mockResolvedValue(okStream());
    vi.stubGlobal('fetch', f);
    await callAzure(conn, 'k', 'gpt-5-chat', msgs);
    const [body] = bodies(f);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('falls back when a deployment rejects a parameter', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(err400("Unsupported parameter: 'max_completion_tokens'"))
      .mockResolvedValueOnce(err400("Unrecognized request argument supplied: reasoning_effort"))
      .mockResolvedValueOnce(err400('stream_options is not supported'))
      .mockResolvedValueOnce(okStream('ok'));
    vi.stubGlobal('fetch', f);
    const r = await callAzure(conn, 'k', 'old-deploy', msgs, undefined, { reasoningEffort: 'low', maxTokens: 500 });
    expect(r.message.content).toBe('ok');
    const b = bodies(f);
    expect(b[1]).toMatchObject({ max_tokens: 500 });
    expect(b[2]).not.toHaveProperty('reasoning_effort');
    expect(b[3]).not.toHaveProperty('stream_options');
  });

  it('does not retry other errors', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Access denied due to invalid subscription key' } }), { status: 401 }));
    vi.stubGlobal('fetch', f);
    await expect(callAzure(conn, 'bad', 'gpt-5-chat', msgs)).rejects.toThrow(/invalid subscription key/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('listAzureModels and verifyAzureConnection', () => {
  it('lists valid ids and returns [] when listing is not available', async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-5-chat' }, { id: 'bad id' }, { id: 'gpt-5-chat' }] }), { status: 200 }));
    expect(await listAzureModels(conn, 'k', ok)).toEqual(['gpt-5-chat']);
    expect(await listAzureModels(conn, 'k', vi.fn().mockResolvedValue(new Response('', { status: 404 })))).toEqual([]);
    expect(await listAzureModels(conn, 'k', vi.fn().mockRejectedValue(new Error('offline')))).toEqual([]);
  });

  it('explains key, deployment and network problems', async () => {
    const res = (status: number, message = 'x') => vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message } }), { status }));
    expect(await verifyAzureConnection(conn, 'k', 'd', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))).toBeUndefined();
    expect(await verifyAzureConnection(conn, 'k', 'd', res(401))).toMatch(/rejected the key/);
    expect(await verifyAzureConnection(conn, 'k', 'd', res(404))).toMatch(/couldn't find deployment "d"/);
    expect(await verifyAzureConnection(conn, 'k', 'd', res(400, 'Unsupported parameter: max_completion_tokens'))).toBeUndefined();
    expect(await verifyAzureConnection(conn, 'k', 'd', vi.fn().mockRejectedValue(new Error('ENOTFOUND')))).toMatch(/Couldn't reach Azure/);
  });
});
