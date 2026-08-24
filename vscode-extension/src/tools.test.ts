// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from './tools';
import { createThread, saveThreadMessages } from './threadStore';

// search_past_work is the one tool whose whole job is reading OTHER
// threads' stored history — real value only comes from testing it
// against real thread files on disk, not a mock. Uses threadStore.ts's
// own public API (createThread/saveThreadMessages) to build fixtures,
// the same way the real product creates them, rather than hand-writing
// the on-disk JSON shape.
describe('search_past_work', () => {
  let tmpDir: string;
  let context: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-tools-test-'));
    context = {
      globalStorageUri: { fsPath: tmpDir },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      globalState: { get: (_k: string, def: unknown) => def, update: async () => {} },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds a file touched in a different thread and excludes the current one', async () => {
    const other = createThread(context, 'Fix the auth bug');
    saveThreadMessages(context, other.id, [
      { role: 'user', content: 'fix the login bug' },
      { role: 'assistant', content: 'Fixed it.', touchedFiles: ['src/auth.ts'] },
    ]);
    const current = createThread(context, 'Unrelated chat');
    saveThreadMessages(context, current.id, [
      { role: 'user', content: 'also touches auth.ts' },
      { role: 'assistant', content: 'Done.', touchedFiles: ['src/auth.ts'] },
    ]);

    const result = await executeTool(context, 'search_past_work', JSON.stringify({ path: 'src/auth.ts' }), [], current.id);
    expect(result).toContain('Fix the auth bug');
    expect(result).not.toContain('Unrelated chat');
  });

  it('reports no record when the file was never touched anywhere', async () => {
    const t = createThread(context, 'Some chat');
    saveThreadMessages(context, t.id, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', touchedFiles: ['src/other.ts'] },
    ]);

    const result = await executeTool(context, 'search_past_work', JSON.stringify({ path: 'src/nonexistent.ts' }), []);
    expect(result).toContain('No record');
  });

  it('matches by path suffix and by basename, not only exact string equality', async () => {
    const t = createThread(context, 'Deep path thread');
    saveThreadMessages(context, t.id, [
      { role: 'user', content: 'edit it' },
      { role: 'assistant', content: 'done', touchedFiles: ['packages/api/src/routes/users.ts'] },
    ]);

    const suffixMatch = await executeTool(context, 'search_past_work', JSON.stringify({ path: 'src/routes/users.ts' }), []);
    expect(suffixMatch).toContain('Deep path thread');

    const basenameMatch = await executeTool(context, 'search_past_work', JSON.stringify({ path: 'users.ts' }), []);
    expect(basenameMatch).toContain('Deep path thread');
  });

  it('does not match an unrelated file that merely shares a basename in a different-enough path', async () => {
    // "config.ts" appearing under two completely unrelated top-level
    // dirs should still match by basename per the documented fallback —
    // this test exists to make that trade-off explicit, not to assert
    // it never happens. A real regression would be matching on a
    // substring with no path-boundary alignment at all.
    const t = createThread(context, 'Config thread');
    saveThreadMessages(context, t.id, [
      { role: 'user', content: 'edit config' },
      { role: 'assistant', content: 'done', touchedFiles: ['src/config.ts'] },
    ]);

    const noMatch = await executeTool(context, 'search_past_work', JSON.stringify({ path: 'src/configuration.ts' }), []);
    expect(noMatch).toContain('No record');
  });
});
