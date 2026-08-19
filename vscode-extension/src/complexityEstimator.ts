// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Picks a *starting* variant within whatever company the user already
// locked the thread to — the original "cheap classifier decides, then
// routes" idea, done the way this project's own history says it has to
// be done to actually work: it only ever runs once, on a thread's first
// message, before anything is sent — never mid-conversation, never
// across companies (see providers.ts, chatPanel.ts's handleSend). A
// wrong guess here just costs one manual switch, same as always having
// started on the cheapest tier did — this only ever reduces how often
// that manual switch is needed, never introduces the reclassify-every-
// message failure mode that broke the first version of this idea.
//
// Deliberately a keyword/shape heuristic, not a model call — spending
// tokens (and latency) on an LLM just to decide which LLM to use would
// undercut the entire cost-efficiency point of picking a cheap starting
// tier in the first place.
export type StartingTier = 0 | 1 | 2;

const CODE_BLOCK_PATTERN = /```/;
const STACK_TRACE_PATTERN = /\bTraceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\)|\b[A-Za-z.]+(Error|Exception):/;
// Words that signal "this is a real, multi-step piece of work" strongly
// enough to jump straight to the strongest variant on their own —
// weighted higher than the other signals below, which only nudge one
// tier up.
const BIG_ASK_PATTERN = /\b(refactor|redesign|migrate|rewrite|architecture|audit|from scratch|end[- ]to[- ]end|comprehensive)\b/i;
// A short greeting/ack forces the cheapest tier regardless of anything
// else — "thanks" containing a coding-flavored word by coincidence
// shouldn't matter.
const TRIVIAL_PATTERN = /^\s*(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|sounds good|cool)\b/i;

// A conservative scoring cap, not a precise one — leaning toward the
// cheap tier when signals are ambiguous is the whole point (auto-
// escalation on *observed* struggle, once that lands, is the mechanism
// for correcting an under-guess; over-guessing here has no equivalent
// correction and just spends money that didn't need spending).
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
