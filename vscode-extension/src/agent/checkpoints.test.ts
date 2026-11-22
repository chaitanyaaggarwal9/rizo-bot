// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changedSince,
  deleteThreadCheckpoints,
  loadCheckpoint,
  MAX_CHECKPOINTS_PER_THREAD,
  rewind,
  saveCheckpoint,
  TurnCheckpoint,
} from './checkpoints';

let ws: string;
let store: string;
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-ws-')));
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-store-'));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

const write = (p: string, c: string) => fs.writeFileSync(p, c);
const read = (p: string) => fs.readFileSync(p, 'utf-8');
const inside = (p: string) => p.startsWith(ws + path.sep);
const restore = (p: string, c: Buffer) => fs.writeFileSync(p, c);
const remove = (p: string) => fs.rmSync(p, { force: true });

describe('TurnCheckpoint and rewind', () => {
  it('restores changed files, removes created ones, and only snapshots the first change', () => {
    const a = path.join(ws, 'a.ts');
    const b = path.join(ws, 'new.ts');
    write(a, 'original');
    const cp = new TurnCheckpoint('t1', '111-abc');
    cp.record(a);
    write(a, 'edit 1');
    cp.record(a); // second write to the same file in the same reply
    write(a, 'edit 2');
    cp.record(b);
    write(b, 'created');
    const data = cp.finish();
    expect(data.files).toHaveLength(2);
    expect(changedSince(data)).toEqual([]);

    const r = rewind(data, inside, restore, remove);
    expect(read(a)).toBe('original');
    expect(fs.existsSync(b)).toBe(false);
    expect(r).toEqual({ restored: [a], deleted: [b], skipped: [] });
  });

  it('reports files edited again after the reply', () => {
    const a = path.join(ws, 'a.ts');
    write(a, 'v1');
    const cp = new TurnCheckpoint('t1', '1-x');
    cp.record(a);
    write(a, 'v2');
    const data = cp.finish();
    write(a, 'v3 by the user');
    expect(changedSince(data)).toEqual([a]);
  });

  it('never writes outside the allowed folders', () => {
    const outside = path.join(store, 'outside.txt');
    write(outside, 'keep me');
    const cp = new TurnCheckpoint('t1', '2-y');
    cp.record(outside);
    write(outside, 'changed');
    const r = rewind(cp.finish(), inside, restore, remove);
    expect(read(outside)).toBe('changed');
    expect(r.skipped[0]).toMatchObject({ absPath: outside, reason: 'outside the workspace' });
  });

  it('restores binary content exactly', () => {
    const img = path.join(ws, 'logo.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    fs.writeFileSync(img, bytes);
    const cp = new TurnCheckpoint('t1', '3-z');
    cp.record(img);
    write(img, 'oops');
    rewind(cp.finish(), inside, restore, remove);
    expect(fs.readFileSync(img).equals(bytes)).toBe(true);
  });
});

describe('saving checkpoints', () => {
  it('saves, loads, and keeps only the newest per chat', () => {
    const a = path.join(ws, 'a.ts');
    write(a, 'x');
    for (let i = 0; i < MAX_CHECKPOINTS_PER_THREAD + 3; i++) {
      const cp = new TurnCheckpoint('t9', `${i}-turn`);
      cp.record(a);
      const data = cp.finish();
      saveCheckpoint(store, data);
      const file = path.join(store, 'checkpoints', 't9', `${i}-turn.json`);
      fs.utimesSync(file, i + 1, i + 1); // make the order deterministic
    }
    const kept = fs.readdirSync(path.join(store, 'checkpoints', 't9'));
    expect(kept).toHaveLength(MAX_CHECKPOINTS_PER_THREAD);
    expect(loadCheckpoint(store, 't9', '0-turn')).toBeUndefined();
    expect(loadCheckpoint(store, 't9', `${MAX_CHECKPOINTS_PER_THREAD + 2}-turn`)?.files[0].absPath).toBe(a);
    deleteThreadCheckpoints(store, 't9');
    expect(fs.existsSync(path.join(store, 'checkpoints', 't9'))).toBe(false);
  });

  it('refuses ids that could escape the store', () => {
    const cp = new TurnCheckpoint('../evil', '1-a');
    expect(() => saveCheckpoint(store, cp.finish())).toThrow();
    expect(loadCheckpoint(store, 't1', '../../x')).toBeUndefined();
  });
});
