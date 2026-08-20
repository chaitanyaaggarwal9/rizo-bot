// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { detectTaskType } from './modelRouter';

describe('detectTaskType', () => {
  it('classifies an obvious coding question as coding', () => {
    expect(detectTaskType('why is my function throwing a TypeError?')).toBe('coding');
  });

  it('classifies plain conversation as general', () => {
    expect(detectTaskType('what is the capital of France?')).toBe('general');
  });

  it('classifies git workflow questions as coding', () => {
    expect(detectTaskType('how do I squash my last 3 commits before opening a pull request?')).toBe('coding');
  });

  it('classifies design/build vocabulary as coding, not just literal programming terms', () => {
    expect(detectTaskType('design me a landing page for my startup')).toBe('coding');
    expect(detectTaskType('build a mobile app for tracking expenses')).toBe('coding');
  });

  it('uses whole-word matching so a substring inside an unrelated word does not misfire', () => {
    // "api" must not match inside "capital"; "react" must not match "reaction".
    expect(detectTaskType('what is the capital of Japan?')).toBe('general');
    expect(detectTaskType('describe a chemical reaction')).toBe('general');
    expect(detectTaskType('what commitment issues do people usually have?')).toBe('general');
  });

  it('is case-insensitive', () => {
    expect(detectTaskType('HELP ME DEBUG THIS PYTHON SCRIPT')).toBe('coding');
  });
});
