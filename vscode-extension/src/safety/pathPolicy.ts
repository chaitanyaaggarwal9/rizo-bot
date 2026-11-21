// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// File-system safety for the file tools: keeping every read and write
// inside the allowed folders (symlinks included), safe writes, cheap
// binary detection, and exact single replacements. No 'vscode' import, so
// it's tested against real temp folders in pathPolicy.test.ts.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// lstat-based: true for anything with a directory entry, including a
// symlink whose target doesn't exist (fs.existsSync says false for those,
// which is exactly how a dangling link used to slip past the check).
export function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolves a model-supplied path against the allowed roots (already
// realpath'd) and refuses anything that ends up outside them: "../"
// traversal, an absolute path elsewhere, a symlink pointing out, or a
// symlink whose target doesn't exist (whatever it points at could be
// created anywhere). A relative path resolves against the first root.
export function resolveWithinRoots(requestedPath: unknown, roots: readonly string[]): string {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('A non-empty "path" string is required.');
  }
  if (requestedPath.includes('\0')) throw new Error('Path contains a NUL byte, so Rizo refused it.');
  if (!roots.length) throw new Error('No workspace folder is open. Open a folder to let Rizo read or edit files.');

  const resolved = path.resolve(roots[0], requestedPath);
  const matchedRoot = roots.find((root) => isSameOrInside(resolved, root));
  if (!matchedRoot) {
    throw new Error(
      `Path "${requestedPath}" resolves outside every open workspace folder, so Rizo refused it. To work with a different folder, add it to this VS Code workspace (File > Add Folder to Workspace...).`,
    );
  }

  // Walk up to the nearest entry that exists (a new file has no real path
  // yet), then resolve symlinks on it. realpathSync throws on a dangling
  // symlink, which is refused rather than followed.
  let existing = resolved;
  while (!entryExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    throw new Error(`Path "${requestedPath}" goes through a symlink whose target doesn't exist, so Rizo refused it.`);
  }
  if (!isSameOrInside(real, matchedRoot)) {
    throw new Error(`Path "${requestedPath}" escapes the workspace folder through a symlink, so Rizo refused it.`);
  }
  return resolved;
}

// Writes content to a path that resolveWithinRoots already approved.
// Writes to the file's real location (so a symlink inside the workspace
// that points at another workspace file still works), creates missing
// parent folders, and opens with O_NOFOLLOW so a symlink swapped in after
// the check isn't followed.
export function safeWriteFile(filePath: string, content: string): void {
  let target: string;
  if (entryExists(filePath)) {
    target = fs.realpathSync(filePath); // throws on a dangling link
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    target = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  }
  const nofollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | nofollow;
  const fd = fs.openSync(target, flags, 0o666);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads at most `bytes` from the start of a file without loading the rest.
export function readFileHead(filePath: string, bytes = 8000): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Same cheap tell git uses: a NUL byte in the first 8 KB. A UTF-16 file
// (which has NULs) is recognised by its byte-order mark and not treated
// as binary.
export function looksBinary(head: Buffer): boolean {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return false;
  return head.includes(0);
}

export type ReplaceResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'empty' | 'not-found' | 'not-unique'; count: number };

// Replaces exactly one occurrence of oldString. Plain string splicing, so
// "$&", "$$" and friends in newString are written literally (String
// .replace treats them as patterns, which made the written file differ
// from the diff the user approved).
export function replaceExactlyOnce(content: string, oldString: string, newString: string): ReplaceResult {
  if (!oldString) return { ok: false, reason: 'empty', count: 0 };
  const first = content.indexOf(oldString);
  if (first === -1) return { ok: false, reason: 'not-found', count: 0 };
  let count = 1;
  for (let i = content.indexOf(oldString, first + oldString.length); i !== -1; i = content.indexOf(oldString, i + oldString.length)) {
    count++;
  }
  if (count > 1) return { ok: false, reason: 'not-unique', count };
  return { ok: true, content: content.slice(0, first) + newString + content.slice(first + oldString.length) };
}

// read_file's optional line range (1-based, inclusive) plus a size cap, so
// one call can't pour a huge file into the conversation.
export const READ_MAX_CHARS = 100_000;

export function sliceForReading(text: string, startLine?: number, endLine?: number): string {
  const lines = text.split('\n');
  const total = lines.length;
  const start = Number.isInteger(startLine) && (startLine as number) > 0 ? (startLine as number) : 1;
  const end = Number.isInteger(endLine) && (endLine as number) >= start ? Math.min(endLine as number, total) : total;
  const ranged = start > 1 || end < total;
  let out = lines.slice(start - 1, end).join('\n');
  let note = ranged ? `[lines ${start}-${end} of ${total}]\n` : '';
  if (out.length > READ_MAX_CHARS) {
    const shownLines = out.slice(0, READ_MAX_CHARS).split('\n').length - 1;
    out = out.slice(0, READ_MAX_CHARS).split('\n').slice(0, Math.max(shownLines, 1)).join('\n');
    const lastShown = start + Math.max(shownLines, 1) - 1;
    note = `[showing lines ${start}-${lastShown} of ${total}; the file is too large to read at once. Call read_file again with start_line=${lastShown + 1} to continue.]\n`;
  }
  return note + out;
}

// A private folder for the approval diff's before/after files: mkdtemp
// makes it 0700 with an unpredictable name, so other users on the machine
// can't read the contents or plant a symlink in its place.
export function makePrivateTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-diff-'));
}
