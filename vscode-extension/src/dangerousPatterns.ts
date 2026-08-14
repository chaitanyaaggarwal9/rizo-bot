// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// A soft, deterministic backstop for security-hygiene.md: the skill only
// shapes the model's behavior, and the model can still miss its own rules.
// This scans what's actually about to be written, regex-only, no LLM call —
// high-signal patterns only, on purpose. Pure logic, no vscode dependency,
// same shape as destructiveCommands.ts.
export interface DangerousPatternMatch {
  description: string;
}

const DANGEROUS_PATTERNS: { pattern: RegExp; description: string }[] = [
  { pattern: /\beval\s*\(/, description: 'Raw eval() — executes a string as code' },
  { pattern: /new\s+Function\s*\(/, description: 'Function() constructor — executes a string as code' },
  { pattern: /\.innerHTML\s*=/, description: 'innerHTML assignment — can inject unsanitized HTML/script' },
  { pattern: /dangerouslySetInnerHTML/, description: 'React dangerouslySetInnerHTML — bypasses XSS escaping' },
  { pattern: /document\.write\s*\(/, description: 'document.write() — legacy unsanitized DOM injection' },
  { pattern: /child_process\.exec\s*\([^)]*[`+]/, description: 'child_process.exec with string interpolation — shell injection risk' },
  { pattern: /subprocess\.(call|Popen|run)\([^)]*shell\s*=\s*True/, description: 'subprocess ... shell=True — shell injection risk' },
  { pattern: /\bos\.system\s*\(/, description: 'os.system() — unsanitized shell execution' },
  { pattern: /\bpickle\.(load|loads)\s*\(/, description: 'pickle.load(s) — deserializing untrusted data can execute arbitrary code' },
  { pattern: /yaml\.load\s*\((?!.*SafeLoader)/, description: 'yaml.load() without SafeLoader — can deserialize arbitrary Python objects' },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, description: 'A private key embedded in this content' },
  { pattern: /AKIA[0-9A-Z]{16}/, description: 'AWS access key ID pattern' },
  { pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}['"]/i, description: 'Hardcoded-looking secret/credential' },
  { pattern: /rejectUnauthorized\s*:\s*false/, description: 'TLS certificate verification disabled' },
  { pattern: /verify\s*=\s*False/, description: 'TLS certificate verification disabled (requests/urllib3)' },
  { pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, description: 'TLS verification globally disabled' },
  { pattern: /curl\s+[^\n|]*\|\s*(sh|bash)\b/, description: 'Piping a remote download straight into a shell' },
  { pattern: /chmod\s+(-R\s+)?0?777/, description: 'chmod 777 — removes all file permission boundaries' },
];

export function scanDangerousPatterns(content: string): DangerousPatternMatch[] {
  return DANGEROUS_PATTERNS.filter((p) => p.pattern.test(content)).map((p) => ({ description: p.description }));
}
