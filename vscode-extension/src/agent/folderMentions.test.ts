// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { findMentionedPaths } from './folderMentions';

describe('findMentionedPaths', () => {
  it('finds real absolute paths, plain or quoted, and strips trailing punctuation', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-fm-')));
    try {
      fs.mkdirSync(path.join(dir, 'my project'));
      const found = findMentionedPaths(`look in ${dir}. and also "${dir}/my project" please`);
      expect(found).toContain(dir);
      expect(found).toContain(path.join(dir, 'my project'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores path-like text that does not exist', () => {
    expect(findMentionedPaths('version 1/2/3 and /definitely/not/a/real/path/xyz')).toEqual([]);
  });
});
