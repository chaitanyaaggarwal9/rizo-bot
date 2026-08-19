// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Struggle evidence behind the auto-escalation "↑ Retry with {stronger
// variant}" offer (see chatPanel.ts's handleSend). Three deliberately
// cheap, deterministic signals — no extra model call, same "pure logic"
// approach as complexityEstimator.ts — pulled out into their own testable
// function rather than left inline, the way the original single-turn
// version of this shipped, because a real usage transcript caught a gap
// inline reasoning alone hadn't: a cheap model that writes a broken
// multi-file page, then spends several more turns re-checking the same
// missing file instead of writing it. Zero tool errors, nowhere near the
// iteration cap — invisible to the first two signals.
export interface TurnToolActivity {
  // Whether this turn called any tool at all.
  madeToolCall: boolean;
  // Whether any of those calls actually mutated something (write_file /
  // edit_file) rather than just reading or listing.
  madeMutatingCall: boolean;
}

export interface StruggleInput {
  // A user-initiated Stop isn't struggle, it's just Stop.
  wasCancelled: boolean;
  // False only when the tool-call loop fell through the iteration cap
  // without ever getting a tool-call-free reply.
  completedNormally: boolean;
  // The longest run of back-to-back tool errors within this turn — the
  // model gives up and answers anyway after repeatedly hitting the same
  // broken approach, well before the cap.
  maxConsecutiveToolErrors: number;
  // This turn's own tool activity.
  current: TurnToolActivity;
  // The previous stored assistant turn's tool activity in this thread, if
  // any — undefined for a thread's first turn, or for history persisted
  // before this tracking existed. Never treated as a stagnant turn by
  // default, so old history can't retroactively trigger this.
  previous: TurnToolActivity | undefined;
}

// Two turns in a row that both poked around with tools but never wrote
// anything — on its own, either one looks completely fine (maybe there
// really was nothing to change yet); it's the *pair* that's the signal.
export function detectCrossTurnStagnation(current: TurnToolActivity, previous: TurnToolActivity | undefined): boolean {
  return (
    current.madeToolCall && !current.madeMutatingCall &&
    previous?.madeToolCall === true && previous?.madeMutatingCall === false
  );
}

export function detectStruggle(input: StruggleInput): boolean {
  if (input.wasCancelled) return false;
  return (
    !input.completedNormally ||
    input.maxConsecutiveToolErrors >= 3 ||
    detectCrossTurnStagnation(input.current, input.previous)
  );
}
