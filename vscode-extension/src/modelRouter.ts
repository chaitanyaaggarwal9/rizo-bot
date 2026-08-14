export type TaskType = 'low' | 'medium' | 'coding';

export const MODEL_FOR_TASK: Record<TaskType, string> = {
  // Was deepseek/deepseek-v3.2 — DeepSeek's routing on OpenRouter was
  // silently replacing ordinary text ("Chai Agent") with "[PERSON_NAME]",
  // a PII-redaction artifact. OpenRouter's own privacy policy says they
  // don't filter/sanitize inputs themselves, so this is coming from
  // whichever upstream provider serves DeepSeek V3.2 specifically — not
  // fixable on our end. Swapped to a different vendor entirely (even
  // cheaper too) to sidestep it rather than fight someone else's pipeline.
  low: 'openai/gpt-5-nano',
  medium: 'google/gemini-2.5-flash',
  coding: 'anthropic/claude-sonnet-5', // hard pin — always this model for coding, no fallback
};

// Ported from the original chai.agent server.js project's models.config.js.
// Word-boundary matching only — naive substring checks misfire badly
// ("capital" contains "api", "digital" contains "git", "latest" contains "test").
const CODING_KEYWORDS = [
  'code', 'coding', 'function', 'functions', 'bug', 'bugs', 'debug',
  'debugging', 'error', 'errors', 'exception', 'exceptions', 'script',
  'compile', 'syntax', 'variable', 'variables', 'class', 'api', 'apis',
  'array', 'arrays', 'json', 'sql', 'regex', 'refactor', 'typescript',
  'javascript', 'python', 'react', 'node.js', 'npm', 'git', 'terminal',
  'stack trace', 'commit', 'commits', 'push', 'branch', 'branches',
  'merge', 'pull request', 'pull requests', 'rebase',
];

// Words that signal "this needs real reasoning" regardless of message
// length — catches the short-but-hard case word count alone misses, e.g.
// "Explain quantum entanglement" is 3 words but not a low-effort question.
const REASONING_KEYWORDS = [
  'explain', 'explains', 'explaining', 'why', 'compare', 'comparing',
  'comparison', 'analyze', 'analyzing', 'summarize', 'summarizing',
  'summary', 'tradeoff', 'tradeoffs', 'elaborate', 'research', 'investigate',
];

// Words that signal "this is trivial" even if it happens to be a longer,
// rambling message — catches the long-but-simple case word count alone
// misses, e.g. "Thank you so much for your help today, really appreciate
// it!" is 11 words but is just a thank-you.
const TRIVIAL_KEYWORDS = [
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'bye',
  'goodbye', 'sounds good', 'cool',
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const CODING_PATTERN = new RegExp(`\\b(?:${CODING_KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');
const REASONING_PATTERN = new RegExp(`\\b(?:${REASONING_KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');
const TRIVIAL_PATTERN = new RegExp(`\\b(?:${TRIVIAL_KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');

// Word count is only the last-resort fallback now, for messages that don't
// match any keyword list — tunable further once Turso logging (Stage A8)
// gives real data on what's actually working.
const LOW_EFFORT_WORD_LIMIT = 6;

export function detectTaskType(message: string): TaskType {
  if (CODING_PATTERN.test(message)) return 'coding';
  // Reasoning signal wins over a trivial one if a message somehow matches
  // both — better to occasionally over-spend on a borderline case than
  // under-serve a hard question with the cheapest model.
  if (REASONING_PATTERN.test(message)) return 'medium';
  if (TRIVIAL_PATTERN.test(message)) return 'low';
  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  return wordCount <= LOW_EFFORT_WORD_LIMIT ? 'low' : 'medium';
}

export function modelForMessage(message: string): { model: string; taskType: TaskType } {
  const taskType = detectTaskType(message);
  return { model: MODEL_FOR_TASK[taskType], taskType };
}

// gpt-5-nano's vision support on OpenRouter is inconsistent across
// providers; whenever an image is attached (this turn, or replayed from
// earlier in the thread), low/medium bump up to Gemini Flash, which is
// cheap and reliably multimodal. Coding stays on Sonnet 5 either way, it's
// vision-capable already, and it's hard-pinned regardless of images.
export function visionModelForTask(taskType: TaskType): string {
  return taskType === 'coding' ? MODEL_FOR_TASK.coding : MODEL_FOR_TASK.medium;
}
