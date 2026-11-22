// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import {
  describeArguments,
  formatToolResult,
  isAllowedServerUrl,
  LineDecoder,
  parseServerConfigs,
  parseSseMessages,
  qualifiedToolName,
  splitQualifiedName,
  toToolDefinition,
} from './mcpProtocol';

describe('parseServerConfigs', () => {
  it('reads local and remote servers and skips disabled ones', () => {
    const { servers, errors } = parseServerConfigs({
      github: { command: ' npx ', args: ['-y', 'server', 3], env: { TOKEN: 'x', 'bad name': 'y', N: 1 } },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
      off: { command: 'x', disabled: true },
    });
    expect(errors).toEqual([]);
    expect(servers).toEqual([
      { name: 'github', config: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'x' }, cwd: undefined } },
      { name: 'docs', config: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } } },
    ]);
  });

  it('rejects bad names, plain http to other hosts, and empty entries', () => {
    const { servers, errors } = parseServerConfigs({
      'a__b': { command: 'x' },
      '../x': { command: 'x' },
      remote: { url: 'http://example.com/mcp' },
      empty: {},
    });
    expect(servers).toEqual([]);
    expect(errors).toHaveLength(4);
  });

  it('ignores non-objects', () => {
    expect(parseServerConfigs(undefined)).toEqual({ servers: [], errors: [] });
    expect(parseServerConfigs([1])).toEqual({ servers: [], errors: [] });
  });
});

describe('isAllowedServerUrl', () => {
  it('allows https and local http only', () => {
    expect(isAllowedServerUrl('https://x.dev/mcp')).toBe(true);
    expect(isAllowedServerUrl('http://localhost:3000/mcp')).toBe(true);
    expect(isAllowedServerUrl('http://127.0.0.1/mcp')).toBe(true);
    expect(isAllowedServerUrl('http://10.0.0.5/mcp')).toBe(false);
    expect(isAllowedServerUrl('https://user:pw@x.dev/mcp')).toBe(false);
    expect(isAllowedServerUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedServerUrl('not a url')).toBe(false);
  });
});

describe('tool names', () => {
  it('builds and splits qualified names', () => {
    const q = qualifiedToolName('github', 'create.issue');
    expect(q).toBe('mcp__github__create_issue');
    expect(splitQualifiedName(q)).toEqual({ server: 'github', tool: 'create_issue' });
    expect(splitQualifiedName('read_file')).toBeUndefined();
    expect(qualifiedToolName('s', 'x'.repeat(100))).toHaveLength(64);
  });

  it('describes the tool with its server and a safe schema', () => {
    const def = toToolDefinition('docs', {
      name: 'search',
      description: 'Search the docs',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q', 5] },
    });
    expect(def.function).toEqual({
      name: 'mcp__docs__search',
      description: '[MCP server "docs"] Search the docs',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    });
    expect(toToolDefinition('docs', { name: 't' }).function.parameters).toEqual({ type: 'object', properties: {}, required: [] });
  });
});

describe('formatToolResult', () => {
  it('joins text, notes other content, and marks it untrusted', () => {
    const out = formatToolResult('docs', {
      content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'xx' }, { type: 'resource_link', uri: 'file:///a' }],
    });
    expect(out.split('\n')[0]).toContain('untrusted');
    expect(out).toContain('hello\n[image omitted]\n[resource: file:///a]');
  });

  it('starts errors with "Error:" so the chat shows them as failed', () => {
    expect(formatToolResult('docs', { isError: true, content: [{ type: 'text', text: 'nope' }] })).toMatch(/^Error: /);
  });

  it('redacts secrets and falls back to structured content', () => {
    const key = 'sk-' + 'or-v1-' + 'a'.repeat(64);
    expect(formatToolResult('s', { content: [{ type: 'text', text: `key ${key}` }] })).not.toContain(key);
    expect(formatToolResult('s', { structuredContent: { n: 1 } })).toContain('{"n":1}');
    expect(formatToolResult('s', {})).toContain('(no output)');
  });
});

describe('describeArguments', () => {
  it('pretty-prints and caps', () => {
    expect(describeArguments('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(describeArguments('not json')).toBe('not json');
    expect(describeArguments(JSON.stringify({ t: 'x'.repeat(5000) }), 100)).toMatch(/\.\.\. \(\d+ characters\)$/);
  });
});

describe('framing', () => {
  it('decodes newline-delimited JSON across chunks and skips log lines', () => {
    const d = new LineDecoder();
    expect(d.push('{"id":1,')).toEqual([]);
    expect(d.push('"result":{}}\nserver started\n{"id":2}\n')).toEqual([{ id: 1, result: {} }, { id: 2 }]);
  });

  it('parses server-sent events', () => {
    expect(parseSseMessages('event: message\ndata: {"id":1}\n\ndata: bad\n\n: comment\n\ndata: {"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
