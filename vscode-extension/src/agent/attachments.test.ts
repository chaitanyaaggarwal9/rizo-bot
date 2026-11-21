// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitignoreExcludeGlobs, isIncomingAttachment, MAX_ATTACHMENT_BYTES, readAttachmentFile } from './attachments';

describe('readAttachmentFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-att-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads text files as UTF-8', () => {
    const f = path.join(dir, 'notes.md');
    fs.writeFileSync(f, 'héllo');
    expect(readAttachmentFile(f)).toEqual({ attachment: { name: 'notes.md', type: 'text', content: 'héllo' } });
  });

  it('reads images as base64 with the right MIME type', () => {
    const f = path.join(dir, 'shot.JPG');
    fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect(readAttachmentFile(f)).toEqual({
      attachment: { name: 'shot.JPG', type: 'image', content: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64'), mimeType: 'image/jpeg' },
    });
  });

  it('refuses binary files, oversized files and missing files with a message', () => {
    const bin = path.join(dir, 'a.bin');
    fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
    expect(readAttachmentFile(bin)).toEqual({ warning: expect.stringMatching(/binary/) });
    const big = path.join(dir, 'big.txt');
    fs.writeFileSync(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 97));
    expect(readAttachmentFile(big)).toEqual({ warning: expect.stringMatching(/5MB/) });
    expect(readAttachmentFile(path.join(dir, 'nope.txt'))).toEqual({ warning: expect.stringMatching(/Couldn't attach nope.txt/) });
    expect(readAttachmentFile(dir)).toEqual({ warning: expect.stringMatching(/not a regular file/) });
  });
});

describe('isIncomingAttachment', () => {
  it('accepts well-formed attachments and rejects anything else', () => {
    expect(isIncomingAttachment({ name: 'a', type: 'text', content: 'x' })).toBe(true);
    expect(isIncomingAttachment({ name: 'a', type: 'image', content: 'eA==', mimeType: 'image/png' })).toBe(true);
    for (const bad of [null, 'x', {}, { name: 'a', type: 'video', content: 'x' }, { name: 1, type: 'text', content: 'x' }, { name: 'a', type: 'text', content: 'x', mimeType: 5 }]) {
      expect(isIncomingAttachment(bad)).toBe(false);
    }
  });
});

describe('gitignoreExcludeGlobs', () => {
  it('turns each .gitignore entry into file and folder globs, skipping comments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-gi-'));
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '# deps\nnode_modules/\n\ndist\n');
      expect(gitignoreExcludeGlobs(dir)).toEqual(['**/node_modules', '**/node_modules/**', '**/dist', '**/dist/**']);
      expect(gitignoreExcludeGlobs(path.join(dir, 'missing'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
