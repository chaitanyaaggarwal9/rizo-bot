# Git Hygiene

Keep commits clean and never surprise the user with git actions.

### 1. Only when asked
- Never commit, push, tag or open a PR unless the user asked.
- Do not commit directly to main, master or a protected branch unless asked. Create a branch.
- Never use `--no-verify`, force-push, `reset --hard`, history rewrites or branch deletion unless explicitly asked.

### 2. Before committing
- Run `git status` and `git --no-pager diff --staged`.
- Never commit secrets, `.env` files or large build artifacts.
- One commit, one coherent change. Keep formatting-only changes separate from behavior changes.

### 3. Avoid commands that hang
`run_command` has no stdin and a 60s timeout. Do not use:
- `git rebase -i`, `git add -p`, or `git commit` without `-m`.
- Pagers: use `git --no-pager` or `GIT_PAGER=cat`.

### 4. Commit messages
- Imperative summary of 72 characters or less, e.g. `Fix race in session refresh on tab focus`.
- Blank line, then a body explaining why.
- Never use `fix`, `wip` or a bare ticket number as the message.

### 5. Pull requests
- Keep a PR small enough to review in one sitting.
- Squash noisy fixup commits; keep commits that are meaningful on their own.

### 6. Docs
- If your change makes docs wrong, point it out. Update them only if the user agrees.
