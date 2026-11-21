// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// dangerousPatterns.ts warns before a write, with a human still clicking
// Approve/Reject — but run_command's output has no approval step to
// reject at: `cat .env`, `git log -p` on a repo with a committed secret,
// anything that prints a credential flows straight into the model's
// context and thread history with zero review. Redacts the secret value
// in place (e.g. "API_KEY=[REDACTED]") so the model still sees something
// was there, without the extension itself leaking it further.
const REDACTED = '[REDACTED]';

type Replacer = string | ((match: string, ...groups: string[]) => string);

interface RedactionRule {
  pattern: RegExp;
  // Replacement for what pattern matched — a capture group ($1 etc.) to
  // preserve labeling/context around the secret, or REDACTED outright
  // when the whole match IS the secret (a bare key, a PEM block).
  replace: Replacer;
}

// Values under a secret-looking label that are clearly not secrets:
// numbers (TOKEN_TTL=3600, "prompt_tokens": 512), booleans and nulls.
const NOT_A_SECRET = /^["']?(\d+(\.\d+)?|true|false|null|none|undefined|\[REDACTED\])["']?$/i;

// In code-search output (grep, git diff) the "value" after a label is
// often code, not a secret: `token = getToken()`, `token: req.body.token`,
// `password=$DB_PASS`. Those are left visible so the model can still read
// the code. Quoted literals and env-file style values are redacted.
function looksLikeSecretValue(value: string): boolean {
  if (NOT_A_SECRET.test(value)) return false;
  if (/^["'].*["']$/.test(value)) return true;
  if (/[()]/.test(value)) return false; // a call
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) return false; // a property path
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return false; // a variable reference
  return true;
}

// Labels that mark the value after them as a secret, in env files, shell
// output, JSON, YAML and config files.
const SECRET_LABEL =
  '[\\w.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|passphrase|private[_-]?key|access[_-]?key|client[_-]?secret|credentials?|auth[_-]?key|db[_-]?pass)[\\w.-]*';

const REDACTION_RULES: RedactionRule[] = [
  // Private key blocks first, whole block, so later rules don't chop them
  // up. A block cut off before its END line (head -5 ~/.ssh/id_rsa, or
  // output truncated mid-key) is redacted to the end of the text.
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: REDACTED,
  },
  // Credentials inside a URL: postgres://user:pass@host, https://user:token@github.com
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]*:)[^\s@/'"]+(@)/gi, replace: `$1${REDACTED}$2` },
  // This extension's own kind of key — echoing $OPENROUTER_API_KEY or
  // catting a .env containing one would otherwise hand it straight back
  // to OpenRouter as part of the conversation.
  { pattern: /sk-or-v1-[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  // OpenAI project / service-account / admin keys contain - and _.
  { pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  // Stripe secret and restricted keys (publishable pk_ keys are public).
  { pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  // GitHub: classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
  { pattern: /\bgh[opusr]_[A-Za-z0-9]{36,}\b/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replace: REDACTED },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: REDACTED },
  // Slack, Google, Hugging Face, npm.
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  // AWS access key IDs: long-term AKIA and temporary ASIA.
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  // JWTs — three dot-separated base64url segments, distinctive enough on
  // its own not to need a label.
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: REDACTED },
  // Authorization headers (curl -v and similar): Bearer and Basic.
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1${REDACTED}` },
  { pattern: /(Basic\s+)[A-Za-z0-9+/=]{8,}/g, replace: `$1${REDACTED}` },
  // Generic labelled secrets: KEY=value, "api_key": "value", password: value.
  // The value runs to the next space, quote or separator, so passwords
  // with symbols (p@ss!) are covered. Numbers and booleans are left alone.
  {
    pattern: new RegExp(`(\\b${SECRET_LABEL}["']?\\s*[:=]\\s*)(["']?[^\\s"',;}]{4,}["']?)`, 'gi'),
    replace: (match: string, prefix: string, value: string) => (looksLikeSecretValue(value) ? `${prefix}${REDACTED}` : match),
  },
];

export function redactSecrets(text: string): string {
  return REDACTION_RULES.reduce(
    (acc, rule) => acc.replace(rule.pattern, rule.replace as (substring: string, ...args: any[]) => string),
    text,
  );
}
