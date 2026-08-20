// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';
import { TaskType } from './modelRouter';

// Every coding-classified message gets this as the base layer — the other
// skill files' own text says they build on top of it.
const BASE_SKILL = 'coding-discipline.md';

// More specific than the low/medium/coding split in modelRouter.ts — this
// decides WHICH coding skill(s) apply, not whether the request is coding-
// related at all. A message can match more than one.
const SKILL_KEYWORDS: Record<string, string[]> = {
  'debugging-discipline.md': [
    'bug', 'bugs', 'debug', 'debugging', 'crash', 'crashes', 'stack trace',
    'traceback', 'broken', 'failing', 'root cause', 'reproduce',
    'regression', 'regressions', 'flaky', 'exception', 'exceptions',
  ],
  'git-hygiene.md': [
    'git', 'commit', 'commits', 'push', 'pull request', 'pull requests',
    'branch', 'branches', 'merge', 'rebase', 'squash',
  ],
  'backend-api-taste.md': [
    'api', 'apis', 'endpoint', 'endpoints', 'restful', 'route', 'routes',
    'http status', 'pagination', 'versioning',
  ],
  'test-discipline.md': [
    'test', 'tests', 'testing', 'spec', 'specs', 'unit test', 'unit tests',
    'mock', 'mocks', 'coverage', 'assert', 'assertion',
  ],
  'security-hygiene.md': [
    'security', 'secure', 'vulnerability', 'vulnerabilities', 'auth',
    'authentication', 'authorization', 'password', 'passwords',
    'encryption', 'sql injection', 'xss', 'owasp', 'sanitize',
    'sanitization', 'jwt', 'oauth',
  ],
  'typescript-taste.md': [
    'typescript', 'generics', 'generic type', 'generic types',
    'type guard', 'type guards', 'discriminated union',
    'discriminated unions', 'utility type', 'utility types', 'tsconfig',
    'type safety', 'branded type', 'branded types',
  ],
  'code-review-discipline.md': [
    'code review', 'code reviews', 'review this pr', 'review my pr',
    'pr review', 'pr reviews',
  ],
  'web-design-taste.md': [
    'website', 'websites', 'web app', 'web apps', 'webapp', 'webapps',
    'web page', 'web pages', 'webpage', 'webpages', 'landing page',
    'landing pages', 'mobile app', 'mobile apps', 'frontend', 'front-end',
    'next.js', 'nextjs', 'tailwind', 'wireframe', 'wireframes', 'mockup',
    'mockups', 'redesign', 'redesigns', 'design system', 'design systems',
    'ui', 'ux',
  ],
  'ui-library-picks.md': [
    'component', 'components', 'toast', 'toasts', 'command menu',
    'command palette', 'drag and drop', 'virtualization', 'dropdown',
    'dropdowns', 'modal', 'modals', 'dialog', 'dialogs', 'chart', 'charts',
    'state management', 'dark mode',
  ],
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const SKILL_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(SKILL_KEYWORDS).map(([file, keywords]) => [
    file,
    new RegExp(`\\b(?:${keywords.map(escapeRegExp).join('|')})\\b`, 'i'),
  ]),
);

// General/low/medium messages don't need engineering-discipline skills —
// only coding-tier messages do.
export function selectSkillFiles(message: string, taskType: TaskType): string[] {
  if (taskType !== 'coding') return [];

  const files = [BASE_SKILL];
  for (const [file, pattern] of Object.entries(SKILL_PATTERNS)) {
    if (pattern.test(message)) files.push(file);
  }
  return files;
}

// Reads the selected skill files fresh on every call (no caching) from the
// extension's own bundled skills/ directory.
export function loadSkillsContent(skillsDir: string, message: string, taskType: TaskType): string {
  const files = selectSkillFiles(message, taskType);
  return files
    .map((file) => {
      try {
        return fs.readFileSync(path.join(skillsDir, file), 'utf-8');
      } catch (err: any) {
        console.warn(`Could not read skill file ${file}:`, err.message);
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}
