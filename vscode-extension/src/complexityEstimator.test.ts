// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { estimateStartingTier } from './complexityEstimator';

describe('estimateStartingTier', () => {
  it('keeps a bare greeting/ack at tier 0 even when the coding-flavored flag is set', () => {
    expect(estimateStartingTier('hey', false, false)).toBe(0);
    expect(estimateStartingTier('thanks!', false, true)).toBe(0);
  });

  it('only short-circuits the trivial-greeting path at 8 words or fewer', () => {
    // Starts with "ok" (a TRIVIAL_PATTERN word) but is long enough, and
    // contains a "big ask" phrase — if the 8-word cap on the trivial
    // short-circuit didn't actually apply, this would incorrectly stay
    // pinned at tier 0 instead of reaching the big-ask check below it.
    const long = "ok let's refactor this entire authentication system, it's unmaintainable";
    expect(estimateStartingTier(long, false, false)).toBe(2);
  });

  it('jumps straight to tier 2 on a "big ask" phrase regardless of other signals', () => {
    expect(estimateStartingTier('please refactor the auth module', false, true)).toBe(2);
    expect(estimateStartingTier('do a comprehensive audit of this repo', false, false)).toBe(2);
    expect(estimateStartingTier('rewrite this from scratch', false, false)).toBe(2);
  });

  it('scores a plain coding-flavored question at tier 1', () => {
    expect(estimateStartingTier('how do I center a div?', false, true)).toBe(1);
  });

  it('scores plain non-coding chat at tier 0', () => {
    expect(estimateStartingTier('what is the capital of France?', false, false)).toBe(0);
  });

  it('stacks signals toward tier 2 — code block + stack trace + attachment', () => {
    const msg = '```\nTraceback (most recent call last):\n  File "x.py", line 1\nValueError: bad\n```';
    expect(estimateStartingTier(msg, true, true)).toBe(2);
  });

  it('a code block alone (one signal) only reaches tier 1', () => {
    expect(estimateStartingTier('```const x = 1;```', false, false)).toBe(1);
  });

  it('a long message alone reaches tier 1', () => {
    const long = Array(65).fill('word').join(' ');
    expect(estimateStartingTier(long, false, false)).toBe(1);
  });

  it('an attachment with no other signal reaches tier 1, not 2', () => {
    expect(estimateStartingTier('what is this?', true, false)).toBe(1);
  });
});
