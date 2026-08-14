// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';

// A place for the USER's own per-project rules, distinct from the
// extension's bundled skills/ — those ship identically to every install,
// this is whatever this one workspace wants layered on top, without
// forking the extension to add it.
const INSTRUCTIONS_RELATIVE_PATH = ['.rizo', 'instructions.md'];
const MAX_INSTRUCTIONS_BYTES = 8 * 1024; // generous for real project rules, cheap to send every turn

// Read fresh every call, no caching — same convention skillsLoader.ts
// already uses for its own files, so edits apply without a reload.
export function loadProjectInstructions(workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return '';
  const filePath = path.join(workspaceRoot, ...INSTRUCTIONS_RELATIVE_PATH);
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (Buffer.byteLength(content, 'utf-8') > MAX_INSTRUCTIONS_BYTES) {
      content = content.slice(0, MAX_INSTRUCTIONS_BYTES) + '\n\n...(truncated — .rizo/instructions.md exceeds the 8KB budget)';
    }
    return content;
  } catch {
    return ''; // most common case: the file doesn't exist — not an error
  }
}
