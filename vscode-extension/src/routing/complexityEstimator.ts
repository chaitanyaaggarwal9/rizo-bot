// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Picks a starting variant within the thread's already-locked provider —
// runs once, on a thread's first message, never mid-conversation or
// across companies. A wrong guess just costs one manual switch, same as
// always starting on the cheapest tier.
//
// A keyword/shape heuristic, not a model call — spending tokens on an LLM
// to decide which LLM to use would undercut the whole cost-efficiency
// point.
export type StartingTier = 0 | 1 | 2;

const CODE_BLOCK_PATTERN = /```/;
const STACK_TRACE_PATTERN = /\bTraceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\)|\b[A-Za-z.]+(Error|Exception):/;
// Signals a real, multi-step piece of work strongly enough to jump
// straight to the strongest variant — weighted higher than the signals
// below, which only nudge one tier up.
const BIG_ASK_PATTERN = /\b(refactor|redesign|migrate|rewrite|architecture|audit|from scratch|end[- ]to[- ]end|comprehensive)\b/i;
// A short greeting/ack forces the cheapest tier regardless of anything
// else — "thanks" containing a coding-flavored word by coincidence
// shouldn't matter.
const TRIVIAL_PATTERN = /^\s*(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|sounds good|cool)\b/i;

// Conservative, not precise — leans toward the cheap tier when ambiguous.
// Auto-escalation on observed struggle corrects an under-guess;
// over-guessing has no equivalent correction.
export function estimateStartingTier(message: string, hasAttachments: boolean, isCodingFlavored: boolean): StartingTier {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  if (TRIVIAL_PATTERN.test(trimmed) && wordCount <= 8) return 0;

  if (BIG_ASK_PATTERN.test(trimmed)) return 2;

  let score = 0;
  if (isCodingFlavored) score += 1;
  if (CODE_BLOCK_PATTERN.test(trimmed)) score += 1;
  if (STACK_TRACE_PATTERN.test(trimmed)) score += 1;
  if (hasAttachments) score += 1;
  if (wordCount > 60) score += 1;

  if (score >= 3) return 2;
  if (score >= 1) return 1;
  return 0;
}
