// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient } from './mcpClient';

const FAKE = path.join(__dirname, 'testdata', 'fakeServer.js');
let client: McpClient | undefined;
afterEach(() => {
  client?.close();
  client = undefined;
});

function start(env: Record<string, string> = {}): McpClient {
  client = McpClient.forConfig({ kind: 'stdio', command: process.execPath, args: [FAKE], env });
  return client;
}

describe('McpClient over stdio', () => {
  it('initializes, lists tools across pages, and calls a tool', async () => {
    const c = start();
    await c.initialize();
    expect(c.serverName).toBe('fake');
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo', 'env', 'hang']);
    const result = await c.callTool('echo', { a: 1 });
    expect(result.content[0].text).toBe('{"a":1}');
  });

  it('reports server errors', async () => {
    const c = start();
    await c.initialize();
    await expect(c.callTool('missing', {})).rejects.toThrow('Unknown tool');
  });

  it('withholds credential variables but passes the config env', async () => {
    process.env.FAKE_SECRET_TOKEN = 'leak';
    try {
      const c = start({ FROM_CONFIG: 'ok' });
      await c.initialize();
      const result = await c.callTool('env', {});
      expect(result.content[0].text).toBe('none ok');
    } finally {
      delete process.env.FAKE_SECRET_TOKEN;
    }
  });

  it('stops a call when the user presses Stop', async () => {
    const c = start();
    await c.initialize();
    const ac = new AbortController();
    const p = c.callTool('hang', {}, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow('Stopped');
  });

  it('fails clearly when the command does not exist', async () => {
    client = McpClient.forConfig({ kind: 'stdio', command: 'rizo-no-such-mcp-server', args: [], env: {} });
    await expect(client.initialize()).rejects.toThrow();
  });
});
