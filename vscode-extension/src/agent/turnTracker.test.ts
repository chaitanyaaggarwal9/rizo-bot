// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { TurnTracker } from './turnTracker';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TurnTracker', () => {
  it('cancels only the turn that was stopped', () => {
    const t = new TurnTracker();
    const a = t.begin('a', 'thread1');
    const b = t.begin('b', 'thread2');
    t.cancel('a');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it('runs turns on the same thread one after another', async () => {
    const t = new TurnTracker();
    const order: string[] = [];
    const first = t.begin('1', 'th');
    const second = t.begin('2', 'th');
    const third = t.begin('3', 'th');
    second.ready.then(() => order.push('2 starts'));
    third.ready.then(() => order.push('3 starts'));
    await first.ready;
    order.push('1 runs');
    await tick();
    expect(order).toEqual(['1 runs']);
    first.finish();
    await tick();
    expect(order).toEqual(['1 runs', '2 starts']);
    second.finish();
    await tick();
    expect(order).toEqual(['1 runs', '2 starts', '3 starts']);
    third.finish();
    expect(t.runningCount).toBe(0);
  });

  it('lets turns on different threads run at the same time', async () => {
    const t = new TurnTracker();
    t.begin('1', 'a');
    const other = t.begin('2', 'b');
    let started = false;
    other.ready.then(() => (started = true));
    await tick();
    expect(started).toBe(true);
  });

  it('starts a turn already cancelled if Stop arrived first', () => {
    const t = new TurnTracker();
    t.cancel('early');
    expect(t.begin('early', 'th').signal.aborted).toBe(true);
    expect(t.begin('later', 'th').signal.aborted).toBe(false);
  });

  it('cancelAll aborts every running turn, and finish is safe to call twice', () => {
    const t = new TurnTracker();
    const a = t.begin('a', 'x');
    const b = t.begin('b', 'y');
    t.cancelAll();
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    a.finish();
    a.finish();
    b.finish();
    expect(t.runningCount).toBe(0);
  });
});
