// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Files attached to a message: reading them from disk (size cap, image
// vs text, binary detection), checking attachments that arrive from the
// chat view, and the .gitignore filter for "Attach workspace file".
// No 'vscode' import: tested in attachments.test.ts.

import * as fs from 'fs';
import * as path from 'path';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB — generous for a screenshot, not for a video

export interface IncomingAttachment {
  name: string;
  type: 'text' | 'image';
  content: string; // utf-8 text, or base64 for images
  mimeType?: string;
}

// Attachments arrive from the chat view, so their shape is checked, not trusted.
export function isIncomingAttachment(a: unknown): a is IncomingAttachment {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.name === 'string' &&
    typeof x.content === 'string' &&
    (x.type === 'text' || x.type === 'image') &&
    (x.mimeType === undefined || typeof x.mimeType === 'string')
  );
}

// Reads a file to attach: images as base64 with their MIME type, text as
// UTF-8. Refuses files over the size cap and binary files (a NUL byte in
// the first 8 KB, the same cheap tell git uses), with a message to show.
export function readAttachmentFile(fsPath: string): { attachment: IncomingAttachment } | { warning: string } {
  const name = path.basename(fsPath);
  try {
    const stat = fs.statSync(fsPath);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return { warning: `${name} is over the 5MB attachment limit — pick a smaller file.` };
    }
    const ext = path.extname(fsPath).toLowerCase();
    const buf = fs.readFileSync(fsPath);
    if (IMAGE_EXTENSIONS.has(ext)) {
      const mimeType = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
      return { attachment: { name, type: 'image', content: buf.toString('base64'), mimeType } };
    }
    if (buf.subarray(0, 8000).includes(0)) {
      return { warning: `${name} looks like a binary file Rizo can't read as text.` };
    }
    return { attachment: { name, type: 'text', content: buf.toString('utf-8') } };
  } catch (err: any) {
    return { warning: `Couldn't attach ${name}: ${err?.message ?? String(err)}` };
  }
}

// Merges the workspace's .gitignore into the file-picker's exclude
// pattern — VS Code's own findFiles exclude param doesn't consult
// .gitignore at all. Simple line-by-line glob conversion, not a full
// parser (no negation, no nested .gitignore) — enough to keep build
// output and vendored deps out of the picker.
export function gitignoreExcludeGlobs(folderPath: string): string[] {
  try {
    const content = fs.readFileSync(path.join(folderPath, '.gitignore'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      // A bare `**/dist` glob only matches something literally named
      // "dist", not anything inside it — but most .gitignore entries have
      // no trailing slash and match both files and dirs. Emitting both
      // forms per line covers both cases without statting the filesystem.
      .flatMap((line) => {
        const name = line.replace(/\/+$/, '');
        return [`**/${name}`, `**/${name}/**`];
      });
  } catch {
    return [];
  }
}
