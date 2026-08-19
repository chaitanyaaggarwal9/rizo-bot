// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// dangerousPatterns.ts scans content *about to be written* and warns
// before the fact — a human still clicks Approve/Reject. Nothing plays
// the same role for run_command's output: `cat .env`, `env`, `aws
// configure list`, `git log -p` on a repo with a committed secret, or any
// command that happens to print a credential all flowed straight back
// into the model's context (and from there into thread history on disk,
// and back out to OpenRouter) with zero review — there's no approval step
// output could even be rejected at. This redacts the secret *value* in
// place (keeping the surrounding line, e.g. "API_KEY=[REDACTED]") so the
// model still sees that something was there without the extension itself
// becoming the thing that leaks it further. Same regex-only, no-LLM-call
// philosophy as dangerousPatterns.ts/destructiveCommands.ts — pure logic,
// no vscode dependency, testable outside the extension host.
const REDACTED = '[REDACTED]';

interface RedactionRule {
  pattern: RegExp;
  // Replacement for what pattern matched — a capture group ($1 etc.) to
  // preserve labeling/context around the secret, or REDACTED outright
  // when the whole match IS the secret (a bare key, a PEM block).
  replace: string;
}

const REDACTION_RULES: RedactionRule[] = [
  // This extension's own kind of key — OpenRouter, OpenAI, Anthropic —
  // the most self-referential leak: a command that echoes $OPENROUTER_API_KEY
  // or cats a .env containing one would otherwise hand it straight back
  // to OpenRouter itself as part of the conversation.
  { pattern: /sk-or-v1-[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /sk-ant-[A-Za-z0-9-]{16,}/g, replace: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ prefixes.
  { pattern: /\bgh[opusr]_[A-Za-z0-9]{36,}\b/g, replace: REDACTED },
  // AWS access key ID (fixed AKIA prefix + 16 chars, always this shape).
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // AWS secret access key — no fixed prefix, so only redact when a label
  // makes it recognizable (env output, aws configure list, a .env dump).
  { pattern: /((?:aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*)['"]?[A-Za-z0-9/+=]{40}['"]?/gi, replace: `$1${REDACTED}` },
  // JWTs — three dot-separated base64url segments, distinctive enough on
  // its own not to need a label.
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: REDACTED },
  // Bearer tokens in an Authorization header dump (curl -v, etc.).
  { pattern: /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, replace: `$1${REDACTED}` },
  // Generic KEY/SECRET/TOKEN/PASSWORD = value — env dumps, .env files,
  // config output. Requires a recognizable label so this doesn't fire on
  // every long alphanumeric string in normal command output.
  { pattern: /((?:api[_-]?key|secret|token|password|passwd)\w*\s*[:=]\s*)['"]?[A-Za-z0-9_\-/+=]{8,}['"]?/gi, replace: `$1${REDACTED}` },
  // Private key blocks — redact the whole block, not just a line.
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replace: REDACTED },
];

export function redactSecrets(text: string): string {
  return REDACTION_RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replace), text);
}
