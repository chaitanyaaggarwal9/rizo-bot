// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compilerKey, findCompiler, runAudit } from './compiler';

const FAKE = path.join(__dirname, 'testdata', 'fake-rizolang');
let ws: string;

function install(at: string) {
  fs.mkdirSync(path.join(at, 'node_modules'), { recursive: true });
  fs.cpSync(FAKE, path.join(at, 'node_modules', 'rizolang'), { recursive: true });
}

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-rzws-')));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('findCompiler', () => {
  it('finds the nearest node_modules/rizolang up to the workspace root', () => {
    install(ws);
    fs.mkdirSync(path.join(ws, 'apps', 'blog'), { recursive: true });
    const c = findCompiler(path.join(ws, 'apps', 'blog'), ws);
    expect(c?.version).toBe('0.6.0');
    expect(c?.bin).toBe(path.join(ws, 'node_modules', 'rizolang', 'build', 'bin.js'));
    expect(compilerKey(c!)).toBe(`${c!.bin}@0.6.0`);
  });

  it('never looks above the workspace', () => {
    install(ws);
    const inner = path.join(ws, 'project');
    fs.mkdirSync(inner);
    expect(findCompiler(inner, inner)).toBeUndefined();
    expect(findCompiler(os.tmpdir(), inner)).toBeUndefined();
  });

  it('rejects a package that is not rizolang or whose bin escapes it', () => {
    install(ws);
    const pkgJson = path.join(ws, 'node_modules', 'rizolang', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    fs.writeFileSync(pkgJson, JSON.stringify({ ...pkg, name: 'not-rizolang' }));
    expect(findCompiler(ws, ws)).toBeUndefined();
    fs.writeFileSync(pkgJson, JSON.stringify({ ...pkg, bin: { rizolang: '../../evil.js' } }));
    fs.writeFileSync(path.join(ws, 'evil.js'), '');
    expect(findCompiler(ws, ws)).toBeUndefined();
    // A symlinked bin pointing outside the package is rejected too.
    fs.writeFileSync(pkgJson, JSON.stringify(pkg));
    const bin = path.join(ws, 'node_modules', 'rizolang', 'build', 'bin.js');
    fs.rmSync(bin);
    fs.symlinkSync(path.join(ws, 'evil.js'), bin);
    expect(findCompiler(ws, ws)).toBeUndefined();
  });
});

describe('runAudit', () => {
  const run = (source: string, env?: string[]) => {
    install(ws);
    return runAudit(findCompiler(ws, ws)!, source, 'app.rz', { node: process.execPath, envAllow: env });
  };

  it('returns compile errors from a copy in an empty private folder', async () => {
    const r: any = await run('auth User by email\n\napi GET /posts {\n  return db.Post.list()\n}\n');
    expect(r.problems).toEqual([expect.objectContaining({ severity: 'error', code: 'RZ0318', line: 3, column: 3 })]);
    // Nothing was written next to the project.
    expect(fs.readdirSync(ws)).toEqual(['node_modules']);
  });

  it('returns audit findings', async () => {
    const r: any = await run('model Post {}\napi POST /posts -> Post.public {\n  public\n}\n');
    expect(r.problems).toEqual([expect.objectContaining({ severity: 'warning', code: 'RA01' })]);
  });

  it('withholds credential variables and runs in a private folder', async () => {
    process.env.FAKE_SECRET_TOKEN = 'x';
    try {
      const r: any = await run('model Post {}\n');
      expect(r.problems.map((p: any) => p.code)).toEqual([]);
      // Unless the user passes the variable through on purpose.
      const passed: any = await run('model Post {}\n', ['FAKE_SECRET_TOKEN']);
      expect(passed.problems.map((p: any) => p.code)).toEqual(['RZ9999']);
    } finally {
      delete process.env.FAKE_SECRET_TOKEN;
    }
  });

  it('refuses non-.rz names and stops when asked', async () => {
    install(ws);
    const c = findCompiler(ws, ws)!;
    expect(await runAudit(c, '', 'notes.txt')).toEqual({ error: 'Only .rz files can be checked.' });
    const ac = new AbortController();
    const p = runAudit(c, 'SLOW', 'app.rz', { node: process.execPath, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect(await p).toEqual({ error: 'Stopped.' });
  });
});
