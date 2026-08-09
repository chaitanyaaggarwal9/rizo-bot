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
const CODING_KEYWORDS = [
  'code', 'coding', 'function', 'bug', 'debug', 'error', 'exception',
  'script', 'compile', 'syntax', 'variable', 'class', 'api', 'array',
  'json', 'sql', 'regex', 'refactor', 'typescript', 'javascript',
  'python', 'react', 'node.js', 'npm', 'git', 'terminal', 'stack trace',
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
