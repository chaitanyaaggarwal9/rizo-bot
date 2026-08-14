// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Shortcuts for the handful of workflows Rizo already has dedicated skill
// files for. Each handler expands to a canned prompt that starts with
// "/name — ..." on purpose, so the chat bubble still visually reads as the
// slash command instead of a wall of unexplained instructions — that's
// also what gets stored and replayed in thread history, since there's no
// separate "what the user actually typed" display field to carry the
// literal "/commit" instead.
const SLASH_COMMANDS: Record<string, (rest: string) => string> = {
  commit: (rest) =>
    `/commit — Review the currently staged and unstaged changes (use \`git status\` / \`git diff\` via run_command), then stage and commit them. Follow Git Hygiene: imperative-mood subject line, a body explaining why not just what, one coherent change per commit — if the diff bundles unrelated changes, say so and propose splitting rather than committing it all as one lump. Confirm before pushing or running anything destructive.${rest ? `\n\nAdditional context: ${rest}` : ''}`,

  review: (rest) =>
    `/review — Review the current diff (\`git diff\` against the base branch, or whatever files I mention) for correctness bugs first, then reuse/simplification/taste. Follow Code Review Discipline: state what the change is trying to do in one sentence before judging how, separate blocking issues from nice-to-haves and label which is which, end with an explicit verdict (approve / request changes / comment).${rest ? `\n\nAdditional context: ${rest}` : ''}`,

  test: (rest) =>
    `/test — Write tests for the change we're discussing (ask me what to target if it's unclear), following Test Discipline: turn the ask into checkable cases first — reproduce a bug with a failing test before fixing it, write invalid-input cases for new validation — before writing implementation to satisfy them.${rest ? `\n\nAdditional context: ${rest}` : ''}`,
};

const SLASH_PATTERN = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/;

// Returns the expanded prompt, or null if this isn't a recognized slash
// command — callers should fall back to sending the original text as-is
// (an unrecognized "/foo" is just literal text, not an error).
export function expandSlashCommand(text: string): string | null {
  const match = text.trim().match(SLASH_PATTERN);
  if (!match) return null;
  const handler = SLASH_COMMANDS[match[1].toLowerCase()];
  return handler ? handler(match[2].trim()) : null;
}
