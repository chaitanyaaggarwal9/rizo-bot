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
  /git\s+clean\s+.*-[a-z]*f/i,
  /rm\s+.*-[a-z]*r[a-z]*f|rm\s+.*-[a-z]*f[a-z]*r/i, // rm -rf / -fr in either flag order
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}
