// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Which model answers is the user's own choice (providers.ts) — this file
// only classifies a message as 'coding' or 'general', which gates
// skillsLoader.ts's skill files and freeModels.ts's fallback ranking.
export type TaskType = 'coding' | 'general';

// Includes git-workflow words so git questions route to the coding tier —
// skillsLoader.ts's Git Hygiene file needs it. Plurals listed explicitly
// rather than via a wildcard suffix, which would turn "class" into a
// match for "classic", "react" into "reaction". Whole-word matching
// avoids that.
const CODING_KEYWORDS = [
  'code', 'coding', 'function', 'functions', 'bug', 'bugs', 'debug',
  'debugging', 'error', 'errors', 'exception', 'exceptions', 'script',
  'compile', 'syntax', 'variable', 'variables', 'class', 'api', 'apis',
  'array', 'arrays', 'json', 'sql', 'regex', 'refactor', 'typescript',
  'javascript', 'python', 'react', 'node.js', 'npm', 'git', 'terminal',
  'stack trace', 'commit', 'commits', 'push', 'branch', 'branches',
  'merge', 'pull request', 'pull requests', 'rebase',
  // Design/build vocabulary — without these, "design me a website" falls
  // through to 'general' and silently skips every skill file
  // (selectSkillFiles only loads them for 'coding').
  'html', 'css', 'website', 'websites', 'web app', 'web apps', 'webapp',
  'webapps', 'web page', 'web pages', 'webpage', 'webpages',
  'landing page', 'landing pages', 'mobile app', 'mobile apps',
  'frontend', 'front-end', 'next.js', 'nextjs', 'tailwind', 'component',
  'components', 'wireframe', 'wireframes', 'mockup', 'mockups',
  'redesign', 'redesigns', 'design system', 'design systems', 'ui', 'ux',
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const CODING_PATTERN = new RegExp(`\\b(?:${CODING_KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');

export function detectTaskType(message: string): TaskType {
  return CODING_PATTERN.test(message) ? 'coding' : 'general';
}
