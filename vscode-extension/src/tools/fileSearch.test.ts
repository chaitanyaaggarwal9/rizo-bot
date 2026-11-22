// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { compileSearch, formatPlan, formatSearchOutcome, parsePlan, planProgress, searchFiles } from './fileSearch';

const files: Record<string, string | Buffer> = {
  'src/a.ts': 'export function retry() {\n  return fetchWithRetry(url);\n}\n',
  'src/b.ts': 'const RETRY_LIMIT = 3;\n// TODO: retry backoff\n',
  '.env': 'RETRY_SECRET=hunter2hunter2\n',
  'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  'config.ts': 'const token = "sk-or-v1-abcdef0123456789abcdef0123456789"; // retry\n',
};
const list = Object.keys(files).map((p) => ({ path: p, absPath: '/ws/' + p }));
const read = (abs: string) => {
  const v = files[abs.slice(4)];
  return v === undefined ? undefined : Buffer.isBuffer(v) ? v : Buffer.from(v);
};

describe('compileSearch', () => {
  it('treats the pattern literally by default and case-insensitively', () => {
    const r = compileSearch({ pattern: 'fetch(url' }) as RegExp;
    expect(r.test('return FETCH(url)')).toBe(true);
    expect((compileSearch({ pattern: 'a.b' }) as RegExp).test('axb')).toBe(false);
  });

  it('supports regexes and reports invalid ones', () => {
    expect((compileSearch({ pattern: 'retr(y|ies)', isRegex: true }) as RegExp).test('retries')).toBe(true);
    expect(compileSearch({ pattern: '(unclosed', isRegex: true })).toHaveProperty('error');
    expect(compileSearch({ pattern: '' })).toHaveProperty('error');
    expect(compileSearch({ pattern: 'x'.repeat(501) })).toHaveProperty('error');
  });
});

describe('searchFiles', () => {
  it('finds matches with paths and lines, skips secret and binary files, and redacts secrets', () => {
    const o = searchFiles(list, read, compileSearch({ pattern: 'retry' }) as RegExp);
    expect(o.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/a.ts:1', 'src/a.ts:2', 'src/b.ts:1', 'src/b.ts:2', 'config.ts:1']);
    expect(o.skippedSecretFiles).toBe(1);
    expect(o.matches.find((m) => m.path === 'config.ts')?.text).not.toContain('sk-or-v1');
    expect(o.filesSearched).toBe(3);
  });

  it('stops at max_results and says so', () => {
    const o = searchFiles(list, read, compileSearch({ pattern: 'retry' }) as RegExp, 2);
    expect(o.matches).toHaveLength(2);
    expect(o.truncated).toBe(true);
    expect(formatSearchOutcome(o, 'retry')).toMatch(/showing the first 2 matches/);
  });

  it('stops when the time budget runs out', () => {
    let t = 0;
    const o = searchFiles(list, read, /retry/i, 100, () => (t += 5000));
    expect(o.timedOut).toBe(true);
  });

  it('formats an empty result clearly', () => {
    const o = searchFiles(list, read, /nothing-here/);
    expect(formatSearchOutcome(o, 'nothing-here')).toBe('No matches for "nothing-here" in 3 files.');
  });
});

describe('update_plan', () => {
  it('parses, formats and counts progress', () => {
    const plan = parsePlan([
      { step: 'Read the handler', status: 'done' },
      { step: 'Add validation', status: 'in_progress' },
      { step: 'Run tests', status: 'whatever' },
    ]);
    expect(Array.isArray(plan)).toBe(true);
    if (!Array.isArray(plan)) return;
    expect(planProgress(plan)).toBe('1/3 done');
    expect(formatPlan(plan)).toBe('[x] Read the handler\n[>] Add validation\n[ ] Run tests');
  });

  it('rejects empty or malformed plans', () => {
    expect(parsePlan([])).toHaveProperty('error');
    expect(parsePlan('nope')).toHaveProperty('error');
    expect(parsePlan([{ status: 'done' }])).toHaveProperty('error');
  });
});
