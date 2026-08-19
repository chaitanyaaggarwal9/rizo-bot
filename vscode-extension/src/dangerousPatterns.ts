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
  // cPickle/cloudpickle/dill/marshal/shelve are all the same deserialize-
  // untrusted-data-executes-code class as bare pickle — extended to catch
  // the variants after comparing against Claude Code's own
  // security-guidance plugin (its regex layer, not the LLM-review one —
  // same relationship dangerousPatterns.ts already has to it per the
  // file comment above).
  { pattern: /\b(pickle|cPickle|cloudpickle|dill)\.(load|loads)\s*\(/, description: 'Deserializing untrusted data (pickle or a variant) can execute arbitrary code' },
  { pattern: /\bmarshal\.loads?\s*\(/, description: 'marshal.load(s) — same deserialization-executes-code risk as pickle' },
  { pattern: /\bshelve\.open\s*\(/, description: 'shelve.open() — built on pickle, same deserialization risk with untrusted data' },
  { pattern: /yaml\.load\s*\((?!.*SafeLoader)/, description: 'yaml.load() without SafeLoader — can deserialize arbitrary Python objects' },
  { pattern: /yaml\.unsafe_load\s*\(/, description: 'yaml.unsafe_load() — can deserialize arbitrary Python objects' },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, description: 'A private key embedded in this content' },
  { pattern: /AKIA[0-9A-Z]{16}/, description: 'AWS access key ID pattern' },
  { pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}['"]/i, description: 'Hardcoded-looking secret/credential' },
  { pattern: /rejectUnauthorized\s*:\s*false/, description: 'TLS certificate verification disabled' },
  { pattern: /verify\s*=\s*False/, description: 'TLS certificate verification disabled (requests/urllib3)' },
  { pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, description: 'TLS verification globally disabled' },
  { pattern: /curl\s+[^\n|]*\|\s*(sh|bash)\b/, description: 'Piping a remote download straight into a shell' },
  { pattern: /chmod\s+(-R\s+)?0?777/, description: 'chmod 777 — removes all file permission boundaries' },
  // Same XSS-sink class as innerHTML above, just the two other DOM APIs
  // that write raw HTML without escaping it.
  { pattern: /\.outerHTML\s*=/, description: 'outerHTML assignment — same XSS risk as innerHTML' },
  { pattern: /\.insertAdjacentHTML\s*\(/, description: 'insertAdjacentHTML() — can inject unsanitized HTML/script' },
  { pattern: /\b(xml\.etree\.ElementTree|ElementTree|ET)\.(parse|fromstring|XML)\s*\(|\bminidom\.(parse|parseString)\s*\(/, description: "Python's stdlib XML parser — vulnerable to XXE (external entity) attacks by default; use defusedxml instead" },
  { pattern: /<script\s+(?![^>]{0,400}integrity\s*=)[^>]{0,200}src\s*=\s*['"](?:https?:)?\/\/[^'"]{1,300}['"]/, description: 'External <script> tag with no Subresource Integrity hash — a compromised CDN could inject anything' },
  { pattern: /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|['"]aes-\d+-ecb['"]/, description: 'AES in ECB mode — leaks plaintext structure (identical blocks encrypt identically)' },
  { pattern: /\bcrypto\.(createCipher|createDecipher)\b/, description: "Node's crypto.createCipher/createDecipher — derives the key insecurely (no IV); use createCipheriv/createDecipheriv" },
  // The one non-JS/Python entry — Rizo had zero coverage for Go before
  // this, and shell-wrapped exec.Command is the exact same
  // shell-injection shape as child_process.exec/os.system above.
  { pattern: /exec\.Command\(\s*"(?:sh|bash|\/bin\/sh|\/bin\/bash)"/, description: 'exec.Command with a shell interpreter — shell injection risk, same as child_process.exec' },
];

export function scanDangerousPatterns(content: string): DangerousPatternMatch[] {
  return DANGEROUS_PATTERNS.filter((p) => p.pattern.test(content)).map((p) => ({ description: p.description }));
}
