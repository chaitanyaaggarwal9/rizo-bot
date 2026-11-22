// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { detectTaskType } from '../routing/modelRouter';
import { BASE_SKILL, EXPLORATION_SKILL, RIZOLANG_SKILL, SKILL_KEYWORDS } from './skillKeywords';
import { loadSkillsContent, MAX_SPECIALIST_SKILLS, selectSkillFiles } from './skillsLoader';

const skillsDir = path.resolve(__dirname, '..', '..', 'skills');
const pick = (msg: string, prev?: string) => selectSkillFiles(msg, detectTaskType(msg), prev);

describe('skill selection', () => {
  it('loads the right specialist for requests that used to load nothing', () => {
    expect(pick('write unit tests for parser.ts')).toContain('test-discipline.md');
    expect(pick('is this login secure?')).toContain('security-hygiene.md');
    expect(pick('why does login crash on submit?')).toContain('debugging-discipline.md');
    expect(pick('add an endpoint for orders')).toContain('backend-api-taste.md');
    expect(pick('please review my changes before I merge')).toContain('code-review-discipline.md');
    expect(pick('the build is failing in CI')).toContain('debugging-discipline.md');
    expect(pick('where is the retry logic implemented in this repo?')).toContain(EXPLORATION_SKILL);
  });

  it('always starts with the base skill and caps the specialists', () => {
    const files = pick('fix the failing tests, the auth api endpoint crashes and the typescript type errors break the react components');
    expect(files[0]).toBe(BASE_SKILL);
    expect(files.length).toBeLessThanOrEqual(1 + MAX_SPECIALIST_SKILLS);
  });

  it('ranks the best-matching specialist first', () => {
    const files = pick('jest tests are flaky: the unit tests and integration tests fail on the mock');
    expect(files[1]).toBe('test-discipline.md');
  });

  it("lets a short follow-up keep the previous request's specialists", () => {
    // In the chat panel a follow-up in a coding thread stays 'coding' (sticky task type).
    expect(selectSkillFiles('ok, do it', 'coding', 'write unit tests for parser.ts')).toContain('test-discipline.md');
    expect(selectSkillFiles('ok, do it', 'coding')).toEqual([BASE_SKILL]);
  });

  it('loads nothing for general conversation', () => {
    expect(pick('what is the capital of France?')).toEqual([]);
    expect(pick('explain photosynthesis to a child')).toEqual([]);
  });
});

describe('detectTaskType', () => {
  it('treats file names and code blocks as coding', () => {
    expect(detectTaskType('what does src/app.py do?')).toBe('coding');
    expect(detectTaskType('why?\n```\nconst x = 1;\n```')).toBe('coding');
  });
});

describe('bundled skill files', () => {
  const files = [BASE_SKILL, ...Object.keys(SKILL_KEYWORDS)];

  it('exist for every skill the selector can pick', () => {
    for (const f of files) expect(fs.existsSync(path.join(skillsDir, f)), f).toBe(true);
  });

  it('stay small and use no em or en dashes', () => {
    for (const f of files) {
      const text = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
      expect(Buffer.byteLength(text), f).toBeLessThanOrEqual(f === BASE_SKILL ? 3000 : 2000);
      expect(/[–—]/.test(text), f).toBe(false);
    }
  });

  it('loads real content joined in order', () => {
    const content = loadSkillsContent(skillsDir, 'write unit tests for parser.ts', 'coding');
    expect(content.startsWith('# Coding Discipline')).toBe(true);
    expect(content).toContain('---');
  });
});

describe('Rizo Lang skill', () => {
  it('loads when the chat mentions Rizo Lang or a .rz file, on top of the specialists', () => {
    expect(pick('write a Rizo Lang app for a blog')).toContain(RIZOLANG_SKILL);
    expect(pick('add a comments endpoint to app.rz')).toContain(RIZOLANG_SKILL);
    expect(pick('why does rizolang say RZ0318?')).toContain(RIZOLANG_SKILL);
    const files = pick('fix the failing tests and the crash in app.rz, the api endpoint breaks');
    expect(files.at(-1)).toBe(RIZOLANG_SKILL);
    expect(files.length).toBe(1 + MAX_SPECIALIST_SKILLS + 1);
  });

  it('loads in projects with .rz files, and for short follow-ups', () => {
    expect(selectSkillFiles('add pagination to posts', 'coding', undefined, { rizoLangProject: true })).toContain(RIZOLANG_SKILL);
    expect(selectSkillFiles('add pagination to posts', 'coding')).not.toContain(RIZOLANG_SKILL);
    expect(selectSkillFiles('ok, do it', 'coding', 'add a Post model to app.rz')).toContain(RIZOLANG_SKILL);
  });

  it('stays out of general chat and unrelated coding', () => {
    expect(pick('what is the capital of France?')).toEqual([]);
    expect(selectSkillFiles('write unit tests for parser.ts', 'coding')).not.toContain(RIZOLANG_SKILL);
    expect(selectSkillFiles('add a Post model to app.rz', 'general', undefined, { rizoLangProject: true })).toEqual([]);
  });

  it('bundles the Rizo Lang 0.6.0 compact spec with its license notice', () => {
    const text = fs.readFileSync(path.join(skillsDir, RIZOLANG_SKILL), 'utf-8');
    expect(text).toContain('docs/SPEC-COMPACT.md at tag v0.6.0');
    expect(text).toContain('Apache License, Version 2.0');
    expect(text).toContain('# Rizo Lang (compact spec, v0.6)');
    expect(text).toContain('rizolang audit');
    // The spec plus Rizo's notes: still small enough for small models.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12_000);
  });
});
