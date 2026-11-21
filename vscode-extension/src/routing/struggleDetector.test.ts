// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { detectCrossTurnStagnation, detectStruggle } from './struggleDetector';

describe('detectStruggle', () => {
  it('does not flag a normal turn that completed without incident', () => {
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 0,
      current: { madeToolCall: true, madeMutatingCall: true }, previous: undefined,
    })).toBe(false);
  });

  it('flags hitting the iteration cap', () => {
    expect(detectStruggle({
      wasCancelled: false, completedNormally: false, maxConsecutiveToolErrors: 0,
      current: { madeToolCall: true, madeMutatingCall: true }, previous: undefined,
    })).toBe(true);
  });

  it('flags 3+ consecutive tool errors even with an otherwise normal finish', () => {
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 3,
      current: { madeToolCall: true, madeMutatingCall: false }, previous: undefined,
    })).toBe(true);
  });

  it('does not flag fewer than 3 consecutive tool errors on their own', () => {
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 2,
      current: { madeToolCall: true, madeMutatingCall: false }, previous: undefined,
    })).toBe(false);
  });

  it('a cancelled turn is never struggle, even shaped like every other signal at once', () => {
    expect(detectStruggle({
      wasCancelled: true, completedNormally: false, maxConsecutiveToolErrors: 5,
      current: { madeToolCall: true, madeMutatingCall: false },
      previous: { madeToolCall: true, madeMutatingCall: false },
    })).toBe(false);
  });

  it('plain chit-chat with no tool calls at all is never stagnation', () => {
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 0,
      current: { madeToolCall: false, madeMutatingCall: false },
      previous: { madeToolCall: false, madeMutatingCall: false },
    })).toBe(false);
  });

  it('a thread with no previous turn (or pre-tracking history) never triggers stagnation on its own', () => {
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 0,
      current: { madeToolCall: true, madeMutatingCall: false }, previous: undefined,
    })).toBe(false);
  });

  // The real transcript this signal was built from: a write turn, then
  // several read-only "is it done?" check-ins in a row that never wrote
  // anything. Struggle should stay quiet through the write and the
  // *first* check-in, then fire starting on the second.
  it('replays the real transcript that motivated cross-turn stagnation', () => {
    const wroteTheFile = { madeToolCall: true, madeMutatingCall: true };
    const checkedOnly = { madeToolCall: true, madeMutatingCall: false };

    // Turn: "similar to Chain Shot!" — writes samegame.html.
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 0,
      current: wroteTheFile, previous: undefined,
    })).toBe(false);

    // Turn: "is it done?" — read-only, but the *previous* turn wrote.
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 0,
      current: checkedOnly, previous: wroteTheFile,
    })).toBe(false);

    // Turn: "?" — read-only again, and now the previous turn was ALSO
    // read-only. This is the catch.
    expect(detectStruggle({
      wasCancelled: false, completedNormally: true, maxConsecutiveToolErrors: 0,
      current: checkedOnly, previous: checkedOnly,
    })).toBe(true);
  });
});

describe('detectCrossTurnStagnation', () => {
  it('requires both turns to have made a tool call and neither to have mutated', () => {
    const readOnly = { madeToolCall: true, madeMutatingCall: false };
    const mutated = { madeToolCall: true, madeMutatingCall: true };
    const noToolCall = { madeToolCall: false, madeMutatingCall: false };

    expect(detectCrossTurnStagnation(readOnly, readOnly)).toBe(true);
    expect(detectCrossTurnStagnation(readOnly, mutated)).toBe(false);
    expect(detectCrossTurnStagnation(mutated, readOnly)).toBe(false);
    expect(detectCrossTurnStagnation(noToolCall, readOnly)).toBe(false);
    expect(detectCrossTurnStagnation(readOnly, undefined)).toBe(false);
  });
});
