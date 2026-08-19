// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Patterns that are hard to reverse once run — per Git Hygiene's own rule,
// these get an elevated warning instead of the same casual prompt as
// something like `npm test`. Pure logic, no vscode dependency, so it's
// testable outside the extension host.
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

  // Shell indirection — none of the patterns above can see *into* a
  // quoted `sh -c "..."` string, a piped-in remote script, or a
  // base64-decoded payload, so a destructive command run this way
  // matched nothing and fell through to the casual approval tier
  // (bypassable via "Always Allow"). Treated as destructive by itself:
  // if what's actually going to run can't be seen, the same elevated,
  // non-bypassable warning applies rather than trusting it by default.
  // Same category Codex's execpolicy treats this class of indirection as
  // (checked its shipped policy engine — prefix rules default to `allow`,
  // but shell wrappers and remote-script execution are exactly the shape
  // it exists to catch). False positives on a legitimate `bash -c` are
  // an acceptable cost here — same tradeoff every rule above already
  // makes: worth an extra click, not "definitely malicious."
  /curl\s+[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /wget\s+[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /base64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
  /\b(sh|bash|zsh)\s+-c\s+/i,
  /\beval\s+/i,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}
