// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Patterns that are hard to reverse once run — these get an elevated
// warning instead of a casual approval prompt.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /git\s+push\s+.*(--force|-f\b)/i,
  /git\s+reset\s+--hard/i,
  // No 'i' flag here — git itself treats -D and -d as different on purpose:
  // -d is the safe delete (refuses if unmerged), -D forces it regardless.
  // Case-insensitive matching would make -d trigger this too.
  /git\s+branch\s+.*-D\b/,
  /git\s+push\s+.*--delete/i,
  // Colon-refspec delete — `git push origin :branch-name` — same effect as
  // --delete but easy to miss since there's no delete-looking flag at all.
  /git\s+push\s+\S+\s+:\S+/i,
  /git\s+clean\s+.*-[a-z]*f/i,
  /rm\s+.*-[a-z]*r[a-z]*f|rm\s+.*-[a-z]*f[a-z]*r/i, // rm -rf / -fr in either flag order
  // Long-form equivalent of -rf, order-independent.
  /rm\s+(?=.*--recursive)(?=.*--force)/i,

  // Shell indirection — none of the patterns above can see into a quoted
  // `sh -c "..."` string, a piped-in remote script, or a base64-decoded
  // payload, so a command run this way would fall through to the casual,
  // bypassable approval tier. Treated as destructive by itself: if what's
  // actually going to run can't be seen, the same elevated warning
  // applies. False positives on a legitimate `bash -c` are an acceptable
  // cost — worth an extra click, not "definitely malicious."
  /curl\s+[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /wget\s+[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /base64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
  /\b(sh|bash|zsh)\s+-c\s+/i,
  /\beval\s+/i,
];

// Zero-width/formatting characters plus bidi embedding/override/isolate
// controls. Two risks, one check: (1) a zero-width character inserted
// mid-keyword (e.g. between "git" and "push") breaks the \s+ patterns
// above without changing how the string looks; (2) a bidi override can
// make the rendered dialog text read differently from the bytes that
// actually execute — a "Trojan Source"-style spoof. A hand-typed command
// essentially never contains these, so presence alone is treated as
// destructive rather than stripped before matching — stripping would
// erase the one signal that something's off.
const INVISIBLE_UNICODE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

export function isDestructive(command: string): boolean {
  if (INVISIBLE_UNICODE.test(command)) return true;
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}
