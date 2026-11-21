// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { contentToPlainText, planSummary, SUMMARIZE_THRESHOLD, SUMMARY_KEEP_TAIL } from './summarizer';

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));

describe('planSummary', () => {
  it('does nothing until the thread is long enough', () => {
    expect(planSummary(msgs(SUMMARIZE_THRESHOLD - 1), 0, undefined)).toBeUndefined();
  });

  it('folds everything except the last turns, after what was already summarized', () => {
    const plan = planSummary(msgs(30), 4, 'earlier summary');
    expect(plan?.foldEnd).toBe(30 - SUMMARY_KEEP_TAIL);
    const user = plan?.prompt[1].content as string;
    expect(user).toContain('Existing summary so far:\nearlier summary');
    expect(user).toContain('user: m4');
    expect(user).not.toContain('user: m2\n');
    expect(user).not.toContain('m' + (30 - SUMMARY_KEEP_TAIL));
    expect(plan?.prompt[0].role).toBe('system');
  });
});

describe('contentToPlainText', () => {
  it('flattens parts and marks images', () => {
    expect(contentToPlainText('hi')).toBe('hi');
    expect(contentToPlainText(null)).toBe('');
    expect(contentToPlainText([{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:x' } }] as any)).toBe('see [image attached]');
  });
});
