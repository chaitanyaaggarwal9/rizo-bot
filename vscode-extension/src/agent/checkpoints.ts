// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Checkpoints: what each file looked like before a reply changed it, so
// the user can undo that reply's file changes later. Saved under the
// extension's global storage, per chat, keeping the most recent replies.
// Commands a reply ran (run_command) can't be undone; the UI says so.
// No 'vscode' import: tested in checkpoints.test.ts.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Files larger than this aren't snapshotted (the undo skips them).
export const MAX_SNAPSHOT_BYTES = 2_000_000;
// Replies with an undo kept per chat.
export const MAX_CHECKPOINTS_PER_THREAD = 20;

export interface FileSnapshot {
  absPath: string;
  existed: boolean;
  content?: string; // base64 of the original bytes, when existed
  tooLarge?: boolean;
  afterHash?: string; // sha256 of the file right after the reply, or 'deleted'
}

export interface CheckpointData {
  threadId: string;
  turnId: string;
  createdAt: string;
  files: FileSnapshot[];
}

const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function hashNow(absPath: string): string {
  try {
    return sha(fs.readFileSync(absPath));
  } catch {
    return 'deleted';
  }
}

// Collects snapshots during one reply. record() is called right before
// each write; only the first write to a file is snapshotted, so the undo
// returns it to how it was before the reply started.
export class TurnCheckpoint {
  private readonly files = new Map<string, FileSnapshot>();

  constructor(
    readonly threadId: string,
    readonly turnId: string,
  ) {}

  record(absPath: string): void {
    if (this.files.has(absPath)) return;
    // One file handle for the size check and the read.
    let snap: FileSnapshot = { absPath, existed: false };
    let fd: number | undefined;
    try {
      fd = fs.openSync(absPath, 'r');
      const size = fs.fstatSync(fd).size;
      snap =
        size > MAX_SNAPSHOT_BYTES
          ? { absPath, existed: true, tooLarge: true }
          : { absPath, existed: true, content: fs.readFileSync(fd).toString('base64') };
    } catch {
      /* doesn't exist yet: undo deletes it */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    this.files.set(absPath, snap);
  }

  get isEmpty(): boolean {
    return this.files.size === 0;
  }

  // Call when the reply ends: remembers what each file looked like
  // afterwards, so an undo can warn about edits made since.
  finish(): CheckpointData {
    const files = [...this.files.values()].map((f) => ({ ...f, afterHash: hashNow(f.absPath) }));
    return { threadId: this.threadId, turnId: this.turnId, createdAt: new Date().toISOString(), files };
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function threadDir(root: string, threadId: string): string {
  if (!SAFE_ID.test(threadId)) throw new Error('Invalid thread id.');
  return path.join(root, 'checkpoints', threadId);
}

export function saveCheckpoint(root: string, data: CheckpointData): void {
  if (!SAFE_ID.test(data.turnId)) throw new Error('Invalid turn id.');
  const dir = threadDir(root, data.threadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${data.turnId}.json`), JSON.stringify(data), { mode: 0o600 });
  // Keep only the newest checkpoints for this chat.
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of all.slice(MAX_CHECKPOINTS_PER_THREAD)) fs.rmSync(path.join(dir, old.f), { force: true });
}

export function loadCheckpoint(root: string, threadId: string, turnId: string): CheckpointData | undefined {
  if (!SAFE_ID.test(turnId)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(threadDir(root, threadId), `${turnId}.json`), 'utf-8'));
    return data && Array.isArray(data.files) ? (data as CheckpointData) : undefined;
  } catch {
    return undefined;
  }
}

export function deleteCheckpoint(root: string, threadId: string, turnId: string): void {
  if (!SAFE_ID.test(turnId)) return;
  try {
    fs.rmSync(path.join(threadDir(root, threadId), `${turnId}.json`), { force: true });
  } catch {
    /* already gone */
  }
}

export function deleteThreadCheckpoints(root: string, threadId: string): void {
  try {
    fs.rmSync(threadDir(root, threadId), { recursive: true, force: true });
  } catch {
    /* nothing to delete */
  }
}

// Files whose current content differs from right after the reply: undoing
// would also throw away those later edits.
export function changedSince(data: CheckpointData): string[] {
  return data.files.filter((f) => f.afterHash && hashNow(f.absPath) !== f.afterHash).map((f) => f.absPath);
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  skipped: { absPath: string; reason: string }[];
}

// Puts every file back. allowPath re-checks each path against the
// workspace (and allowed folders) at undo time, so a stored path can never
// write outside them. writeFile and deleteFile are injected so the caller
// can use its safe writer (no symlink following).
export function rewind(
  data: CheckpointData,
  allowPath: (absPath: string) => boolean,
  writeFile: (absPath: string, content: Buffer) => void,
  deleteFile: (absPath: string) => void,
): RewindResult {
  const result: RewindResult = { restored: [], deleted: [], skipped: [] };
  for (const f of data.files) {
    if (!allowPath(f.absPath)) {
      result.skipped.push({ absPath: f.absPath, reason: 'outside the workspace' });
      continue;
    }
    if (f.tooLarge) {
      result.skipped.push({ absPath: f.absPath, reason: 'too large to snapshot' });
      continue;
    }
    try {
      if (f.existed) {
        writeFile(f.absPath, Buffer.from(f.content ?? '', 'base64'));
        result.restored.push(f.absPath);
      } else if (fs.existsSync(f.absPath)) {
        deleteFile(f.absPath);
        result.deleted.push(f.absPath);
      }
    } catch (err: any) {
      result.skipped.push({ absPath: f.absPath, reason: err?.message ?? String(err) });
    }
  }
  return result;
}
