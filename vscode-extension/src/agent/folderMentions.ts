// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';

// Extracts absolute paths the user's message names that exist on disk.
// These are only CANDIDATES: trustPrompts.ts's requestFolderGrants asks
// the user about each one before Rizo may use it, because the text can
// come from a paste or a pre-filled TODO, not just the user's typing.
// Regex extraction is deliberately loose; fs.existsSync is the real
// filter, so anything path-shaped but not real just gets dropped.
export function findMentionedPaths(text: string): string[] {
  const candidates = new Set<string>();
  for (const m of text.matchAll(/(['"])(\/[^'"]+)\1/g)) candidates.add(m[2]);
  for (const m of text.matchAll(/\/[^\s'"]+/g)) candidates.add(m[0].replace(/[.,;:!?)]+$/, ''));
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) found.push(fs.realpathSync(candidate));
    } catch {
      /* not a real path on this OS (too long, invalid characters, etc.) — skip it */
    }
  }
  return found;
}
