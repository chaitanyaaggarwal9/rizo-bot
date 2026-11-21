// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  entryExists,
  looksBinary,
  makePrivateTempDir,
  READ_MAX_CHARS,
  readFileHead,
  replaceExactlyOnce,
  resolveWithinRoots,
  safeWriteFile,
  sliceForReading,
} from './pathPolicy';

const canSymlink = process.platform !== 'win32';

describe('resolveWithinRoots', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-pp-')));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('allows relative and absolute paths inside the root, including new files', () => {
    expect(resolveWithinRoots('src/a.ts', [root])).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveWithinRoots(path.join(root, 'src', 'a.ts'), [root])).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveWithinRoots('src/new/deep/file.ts', [root])).toBe(path.join(root, 'src', 'new', 'deep', 'file.ts'));
  });

  it('refuses traversal, absolute paths outside, and bad input', () => {
    expect(() => resolveWithinRoots('../outside/secret.txt', [root])).toThrow(/outside every open workspace/);
    expect(() => resolveWithinRoots(path.join(outside, 'secret.txt'), [root])).toThrow(/outside every open workspace/);
    expect(() => resolveWithinRoots('', [root])).toThrow();
    expect(() => resolveWithinRoots(42, [root])).toThrow();
    expect(() => resolveWithinRoots('a\0b', [root])).toThrow(/NUL/);
    expect(() => resolveWithinRoots('src/a.ts', [])).toThrow(/No workspace/);
  });

  it('accepts a path in a second root (multi-root workspace)', () => {
    expect(resolveWithinRoots(path.join(outside, 'secret.txt'), [root, outside])).toBe(path.join(outside, 'secret.txt'));
  });

  it.runIf(canSymlink)('refuses a symlink that points outside', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    expect(() => resolveWithinRoots('link.txt', [root])).toThrow(/escapes/);
    expect(() => resolveWithinRoots('linkdir/new.txt', [root])).toThrow(/escapes/);
  });

  it.runIf(canSymlink)('refuses a dangling symlink, as a file or as a folder on the way', () => {
    fs.symlinkSync(path.join(outside, 'does-not-exist.plist'), path.join(root, 'x.plist'));
    fs.symlinkSync(path.join(outside, 'missing-dir'), path.join(root, 'gone'));
    expect(() => resolveWithinRoots('x.plist', [root])).toThrow(/doesn't exist/);
    expect(() => resolveWithinRoots('gone/new.txt', [root])).toThrow(/doesn't exist/);
  });

  it.runIf(canSymlink)('allows a symlink that stays inside the root', () => {
    fs.symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'));
    expect(resolveWithinRoots('alias.ts', [root])).toBe(path.join(root, 'alias.ts'));
  });
});

describe('safeWriteFile', () => {
  let base: string;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-sw-')));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('creates parent folders and writes new files', () => {
    const f = path.join(base, 'a', 'b', 'c.txt');
    safeWriteFile(f, 'hello');
    expect(fs.readFileSync(f, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file', () => {
    const f = path.join(base, 'x.txt');
    fs.writeFileSync(f, 'old content that is longer');
    safeWriteFile(f, 'new');
    expect(fs.readFileSync(f, 'utf-8')).toBe('new');
  });

  it.runIf(canSymlink)('writes through an in-root symlink to the real file, and refuses a dangling one', () => {
    const real = path.join(base, 'real.txt');
    fs.writeFileSync(real, 'r');
    fs.symlinkSync(real, path.join(base, 'alias.txt'));
    safeWriteFile(path.join(base, 'alias.txt'), 'via alias');
    expect(fs.readFileSync(real, 'utf-8')).toBe('via alias');
    expect(fs.lstatSync(path.join(base, 'alias.txt')).isSymbolicLink()).toBe(true);

    fs.symlinkSync(path.join(base, 'nowhere', 'f'), path.join(base, 'dangling'));
    expect(() => safeWriteFile(path.join(base, 'dangling'), 'x')).toThrow();
    expect(entryExists(path.join(base, 'nowhere', 'f'))).toBe(false);
  });
});

describe('readFileHead and looksBinary', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-rh-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads only the requested prefix', () => {
    const f = path.join(dir, 'big.txt');
    fs.writeFileSync(f, 'x'.repeat(50_000));
    expect(readFileHead(f, 100).length).toBe(100);
  });

  it('flags NUL bytes but not UTF-16 text', () => {
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe(false);
  });
});

describe('replaceExactlyOnce', () => {
  it('writes $ sequences literally', () => {
    const r = replaceExactlyOnce('price = OLD;', 'OLD', '"$$5" + $& + $` + $\'');
    expect(r).toEqual({ ok: true, content: 'price = "$$5" + $& + $` + $\';' });
  });

  it('rejects empty, missing and repeated old strings', () => {
    expect(replaceExactlyOnce('abc', '', 'x')).toMatchObject({ ok: false, reason: 'empty' });
    expect(replaceExactlyOnce('abc', 'z', 'x')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(replaceExactlyOnce('a a a', 'a', 'x')).toMatchObject({ ok: false, reason: 'not-unique', count: 3 });
  });

  it('counts non-overlapping occurrences', () => {
    expect(replaceExactlyOnce('aaaa', 'aa', 'b')).toMatchObject({ ok: false, reason: 'not-unique', count: 2 });
    expect(replaceExactlyOnce('aaa', 'aa', 'b')).toEqual({ ok: true, content: 'ba' });
  });
});

describe('sliceForReading', () => {
  const text = ['one', 'two', 'three', 'four', 'five'].join('\n');

  it('returns the whole file with no note by default', () => {
    expect(sliceForReading(text)).toBe(text);
  });

  it('returns a 1-based inclusive line range with a note', () => {
    expect(sliceForReading(text, 2, 3)).toBe('[lines 2-3 of 5]\ntwo\nthree');
    expect(sliceForReading(text, 4)).toBe('[lines 4-5 of 5]\nfour\nfive');
    expect(sliceForReading(text, 4, 99)).toBe('[lines 4-5 of 5]\nfour\nfive');
  });

  it('caps very large output and says where to continue', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n');
    const out = sliceForReading(big);
    expect(out.length).toBeLessThanOrEqual(READ_MAX_CHARS + 200);
    expect(out).toMatch(/^\[showing lines 1-\d+ of 50000; .*start_line=\d+/);
  });
});

describe('makePrivateTempDir', () => {
  it.runIf(canSymlink)('creates a folder only the current user can open', () => {
    const d = makePrivateTempDir();
    try {
      expect(fs.statSync(d).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
