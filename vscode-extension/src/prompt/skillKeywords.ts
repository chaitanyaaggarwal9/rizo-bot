// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Which bundled skill (skills/*.md) fits a message. Shared by
// modelRouter.ts (is this coding work at all?) and skillsLoader.ts (which
// specialist skills to load), so the two can't drift apart: a message
// that matches a specialist skill always counts as coding.

export const BASE_SKILL = 'coding-discipline.md';

// Loaded for coding messages that ask to explain or find things. These
// words alone ("explain", "where is") don't make a message coding work.
export const EXPLORATION_SKILL = 'codebase-exploration.md';

export const SKILL_KEYWORDS: Record<string, string[]> = {
  'debugging-discipline.md': [
    'bug', 'bugs', 'debug', 'debugging', 'crash', 'crashes', 'crashing', 'stack trace', 'traceback',
    'broken', 'failing', 'fails', 'root cause', 'reproduce', 'regression', 'regressions', 'flaky',
    'exception', 'exceptions', 'not working', "doesn't work", 'error message', 'segfault', 'hangs',
  ],
  'git-hygiene.md': [
    'git', 'commit', 'commits', 'git push', 'pull request', 'pull requests', 'branch', 'branches',
    'merge conflict', 'merge conflicts', 'rebase', 'squash', 'cherry-pick', 'stash', 'gitignore',
  ],
  'backend-api-taste.md': [
    'api', 'apis', 'endpoint', 'endpoints', 'rest api', 'restful', 'graphql', 'http status', 'status code',
    'status codes', 'pagination', 'versioning', 'webhook', 'webhooks', 'api route', 'route handler',
    'backend', 'idempotency', 'rate limit', 'rate limiting',
  ],
  'test-discipline.md': [
    'test', 'tests', 'testing', 'unit test', 'unit tests', 'integration test', 'integration tests', 'e2e',
    'spec', 'specs', 'mock', 'mocks', 'coverage', 'assertion', 'assertions', 'jest', 'vitest', 'pytest',
    'mocha', 'playwright', 'cypress', 'tdd', 'test suite',
  ],
  'security-hygiene.md': [
    'security', 'secure', 'insecure', 'vulnerability', 'vulnerabilities', 'vulnerable', 'auth',
    'authentication', 'authorization', 'login', 'password', 'passwords', 'encryption', 'encrypt',
    'sql injection', 'injection', 'xss', 'csrf', 'cors', 'ssrf', 'owasp', 'sanitize', 'sanitization',
    'jwt', 'oauth', 'secret', 'secrets', 'api key', 'api keys', 'leak', 'leaks', 'permission',
    'permissions', 'exploit', 'cve', 'dependency', 'dependencies', 'npm install', 'pip install',
  ],
  'typescript-taste.md': [
    'typescript', 'generics', 'generic type', 'generic types', 'type guard', 'type guards',
    'discriminated union', 'discriminated unions', 'utility type', 'utility types', 'tsconfig',
    'type safety', 'type error', 'type errors', 'ts error', 'tsc', 'branded type', 'branded types',
  ],
  'code-review-discipline.md': [
    'code review', 'code reviews', 'review this', 'review my', 'review the', 'review pr', 'pr review',
    'pr reviews', 'look over', 'diff', 'feedback on my code',
  ],
  'web-design-taste.md': [
    'website', 'websites', 'web app', 'web apps', 'webapp', 'webapps', 'web page', 'web pages', 'webpage',
    'webpages', 'landing page', 'landing pages', 'mobile app', 'mobile apps', 'frontend', 'front-end',
    'next.js', 'nextjs', 'tailwind', 'wireframe', 'wireframes', 'mockup', 'mockups', 'redesign',
    'redesigns', 'design system', 'design systems', 'ui', 'ux', 'css', 'responsive', 'accessibility',
  ],
  'ui-library-picks.md': [
    'component', 'components', 'toast', 'toasts', 'command menu', 'command palette', 'drag and drop',
    'virtualization', 'virtualized', 'dropdown', 'dropdowns', 'modal', 'modals', 'dialog', 'dialogs',
    'chart', 'charts', 'state management', 'dark mode', 'react', 'form validation',
  ],
  [EXPLORATION_SKILL]: [
    'explain', 'how does', 'how do', 'where is', 'where are', 'what does', 'understand', 'explore',
    'walk me through', 'overview', 'architecture', 'codebase', 'repo', 'repository', 'find where',
  ],
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordPattern(words: string[], flags: string): RegExp {
  return new RegExp(`\\b(?:${words.map(escapeRegExp).join('|')})\\b`, flags);
}

const COUNT_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(SKILL_KEYWORDS).map(([file, words]) => [file, wordPattern(words, 'gi')]),
);

// How many times each skill's keywords appear in the message.
export function skillMatchCounts(message: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [file, pattern] of Object.entries(COUNT_PATTERNS)) {
    const n = (message.match(pattern) || []).length;
    if (n) counts.set(file, n);
  }
  return counts;
}

// Whether a specialist skill (not just the exploration one) matches.
export function matchesSpecialistSkill(message: string): boolean {
  for (const file of skillMatchCounts(message).keys()) {
    if (file !== EXPLORATION_SKILL) return true;
  }
  return false;
}
