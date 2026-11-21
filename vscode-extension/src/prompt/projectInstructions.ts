// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';

// Per-project notes the repository provides, layered on top of the
// extension's bundled skills/. The file comes from the repository, so its
// owner (not necessarily the user) wrote it: trustPrompts.ts asks the user
// before it's used, and permissions.ts's frameProjectNotes presents it to
// the model as context rather than as instructions.
const INSTRUCTIONS_RELATIVE_PATH = ['.rizo', 'instructions.md'];
const MAX_INSTRUCTIONS_BYTES = 8 * 1024; // generous for real project rules, cheap to send every turn

export function projectInstructionsPath(workspaceRoot: string | undefined): string | undefined {
  return workspaceRoot ? path.join(workspaceRoot, ...INSTRUCTIONS_RELATIVE_PATH) : undefined;
}

// Read fresh every call, no caching — same convention skillsLoader.ts
// already uses for its own files, so edits apply without a reload.
export function loadProjectInstructions(workspaceRoot: string | undefined): string {
  const filePath = projectInstructionsPath(workspaceRoot);
  if (!filePath) return '';
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length <= MAX_INSTRUCTIONS_BYTES) return bytes.toString('utf-8');
    // Cut by bytes (not characters) so non-ASCII text can't exceed the
    // budget; a split multi-byte character at the end decodes as U+FFFD.
    return (
      bytes.subarray(0, MAX_INSTRUCTIONS_BYTES).toString('utf-8') +
      '\n\n...(truncated: .rizo/instructions.md exceeds the 8KB budget)'
    );
  } catch {
    return ''; // most common case: the file doesn't exist — not an error
  }
}
