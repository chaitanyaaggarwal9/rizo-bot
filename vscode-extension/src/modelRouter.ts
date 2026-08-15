// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Which model answers is now the user's own explicit choice (see
// providers.ts + the new-chat provider picker in chatPanel.ts) — this file
// no longer picks a model. What's left is classifying a message as
// 'coding' or 'general', which still matters for two things: skillsLoader.ts
// only loads engineering-discipline skill files for 'coding' messages, and
// freeModels.ts's fallback chain has a separate coding-flavored ranking.
export type TaskType = 'coding' | 'general';

// Includes git-workflow words (commit, push, branch, merge, pull request,
// rebase) so git questions route to the coding tier too — skillsLoader.ts's
// Git Hygiene file only loads for messages already classified 'coding' here.
// Plural/inflected forms are listed explicitly, not matched via a wildcard
// suffix — a wildcard would turn "class" into a match for "classic", "react"
// into a match for "reaction", "exception" into a match for "exceptional",
// "commit" into a match for "commitment". Strict whole-word matching avoids all of that.
const CODING_KEYWORDS = [
  'code', 'coding', 'function', 'functions', 'bug', 'bugs', 'debug',
  'debugging', 'error', 'errors', 'exception', 'exceptions', 'script',
  'compile', 'syntax', 'variable', 'variables', 'class', 'api', 'apis',
  'array', 'arrays', 'json', 'sql', 'regex', 'refactor', 'typescript',
  'javascript', 'python', 'react', 'node.js', 'npm', 'git', 'terminal',
  'stack trace', 'commit', 'commits', 'push', 'branch', 'branches',
  'merge', 'pull request', 'pull requests', 'rebase',
  // Design/build vocabulary — without these, "design me a website" or
  // "build a mobile app" match nothing above and fall through to
  // 'general', which also silently skips every skill file (Coding
  // Discipline, Web Design Taste, ...) since selectSkillFiles only loads
  // them for taskType 'coding'. See skillsLoader.ts.
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
