// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Free-tier model routing config, ranked by known capability.
//
// ⚠️ THESE MODEL IDS GO STALE. OpenRouter adds/removes/renames free-tier
// models regularly. Periodically check https://openrouter.ai/models?max_price=0
// and update the lists below. Last checked: 2026-08-08.
const FREE_MODELS = {
  coding: [
    'poolside/laguna-s-2.1:free', // Poolside coding agent model, 118B/8B-active
    'poolside/laguna-xs-2.1:free', // smaller Poolside coding agent model
    'cohere/north-mini-code:free', // Cohere's agentic coding model
  ],
  general: [
    'nvidia/nemotron-3-ultra-550b-a55b:free', // largest free model, frontier reasoning
    'google/gemma-4-31b-it:free', // strong dense general model
    'openai/gpt-oss-20b:free', // solid general open-weight model
  ],
  fallback: 'openrouter/free', // OpenRouter's free-models router — last resort, always answers
};

// Simple keyword check: coding-flavored words -> "coding" list, else "general".
// This determines which ranked list to use, not which specific model within it.
// Includes git-workflow words (commit, push, branch, merge, pull request,
// rebase) so git questions route to the coding tier too — skills.config.js's
// Git Hygiene file only loads for messages already classified "coding" here.
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
  // "build a mobile app" match nothing above and fall through to the
  // general list, which also silently skips every skill file (Coding
  // Discipline, Web Design Taste, ...) since those only load for
  // taskType 'coding'. See skills.config.js.
  'html', 'css', 'website', 'websites', 'web app', 'web apps', 'webapp',
  'webapps', 'web page', 'web pages', 'webpage', 'webpages',
  'landing page', 'landing pages', 'mobile app', 'mobile apps',
  'frontend', 'front-end', 'next.js', 'nextjs', 'tailwind', 'component',
  'components', 'wireframe', 'wireframes', 'mockup', 'mockups',
  'redesign', 'redesigns', 'design system', 'design systems', 'ui', 'ux',
];

// Match whole words only — a naive substring check (e.g. "message.includes(kw)")
// misfires badly: "capital" contains "api", "digital" contains "git",
// "subscription" contains "script", "terror" contains "error".
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const CODING_KEYWORD_PATTERN = new RegExp(
  `\\b(?:${CODING_KEYWORDS.map(escapeRegExp).join('|')})\\b`,
  'i',
);

function detectTaskType(message) {
  return CODING_KEYWORD_PATTERN.test(message) ? 'coding' : 'general';
}

module.exports = { FREE_MODELS, detectTaskType };
