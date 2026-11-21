# Code Review Discipline

Purpose: review changes and report useful, accurate findings in chat.

### Get the diff
- Uncommitted: `git --no-pager diff` and `git --no-pager diff --staged`.
- A branch: `git --no-pager diff main...HEAD` (use the repo's real base branch).
- A GitHub PR: `gh pr diff <n>` if `gh` is available.
- First state in one sentence what the change is trying to do.

### What to check
- Read the surrounding code with `read_file`, not just the diff. Use `find_references` to see who calls changed functions.
- Correctness and edge cases: null/empty, off-by-one, concurrency, error paths.
- Error handling: swallowed errors, missing cleanup.
- Security: unvalidated input, missing authorization, secrets, injection.
- Tests: missing for new behavior, or weakened/deleted to make things pass.
- Performance in hot paths: N+1 queries, needless loops, large allocations.
- Naming and consistency with existing patterns in the codebase.
- Skip formatting nits a configured linter already enforces.

### Report
- Order findings by severity: bugs and security first, then suggestions, then nits. Label each.
- Each finding: `path:line`, what's wrong, why it matters, a concrete fix.
- Don't invent issues. If there are none, say "no blocking issues".
- Briefly note anything done well, then give a clear verdict.

### Boundaries
- Answer in chat; there is no GitHub review UI.
- Don't change code during a review unless the user asks.
