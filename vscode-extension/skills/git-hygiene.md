# Git Hygiene

Coding Discipline covers the code itself; this covers the commit and PR that carry it. History is documentation someone reads later under pressure — mid-incident, mid-bisect, mid-review. Treat it with the same care as the code it records.

### 1. One commit, one coherent change

A commit should be revertable on its own without breaking the tree. Don't bundle an unrelated refactor, a formatting pass, and the actual feature into one commit — split them, even if they land in the same PR. A reviewer (or a future `git bisect`) needs to be able to isolate what each commit did.

### 2. Write the message for someone with no other context

The diff already shows *how* it changed. The message's job is *why* — imperative-mood subject line, blank line, then body explaining motivation or context the diff can't carry (a linked issue, a tradeoff considered and rejected, why now).

| Weak | Strong |
|---|---|
| `fix` | `Fix race condition in session refresh on tab focus` |
| `updates` | `Bump retry backoff from 200ms to 1s after prod timeout spike` |
| `wip` | (don't ship a WIP commit message — squash it before merging) |

### 3. Size a PR for one sitting

If a reviewer can't hold the whole diff in their head in one sitting, that's a signal to split the PR, not to write a longer description to compensate. Large mechanical changes (renames, formatting) belong in their own commit or PR, separate from behavior changes, so a reviewer can skim one and actually read the other.

### 4. Squash vs. preserve, deliberately

- **Squash** noisy WIP/fixup/"address review comments" commits before merging — they're process artifacts, not history worth keeping.
- **Preserve** separate commits when each one is independently meaningful — e.g. a refactor commit followed by the feature that needed it, so a reviewer can verify the refactor alone was behavior-preserving before reading the feature on top of it.

### 5. Refuse by default

- Force-pushing over history other people have already pulled, without checking who else has it.
- Rewriting a shared branch's history to "clean it up" after the fact.
- A commit message that's just the ticket number, or `fix`/`wip`/`updates` as the final message.
- Mixing formatting-only changes into a feature commit — it turns a reviewable diff into noise.

### 6. Destructive git operations need the same confirm-first habit as any other hard-to-reverse action

`push --force`, `reset --hard`, history rewrites, and branch deletion are all easy to run and hard to undo once someone else has pulled. Confirm before running them on anything shared, not just on your own local branch.

### 7. Before pushing, check the docs are still true

Documentation rots the moment code changes without it. Before `git push`, check whether the change touches what these files claim — create the file if the repo needs it and doesn't have one yet, update it if it exists and is now wrong, leave it alone otherwise:

| Doc | Audience | Update it when | Format |
|---|---|---|---|
| `README.md` | New engineer, first hour | Setup steps or architecture change | Free-form, but keep a TOC once it exceeds ~5 sections |
| `CHANGELOG.md` | Engineers, at every release | Every user-facing change merged to main | [Keep a Changelog](https://keepachangelog.com) — `Added`/`Changed`/`Fixed`/`Removed`, grouped by version |
| `CONTRIBUTING.md` | External or new contributors, before their first PR | Dev environment setup, test/lint process, or PR process changes | Free-form — cover environment setup, how to run tests, coding standards, PR process |

Don't touch a doc just to touch it — only when the change actually invalidates something it currently claims. A stale-but-confident doc is worse than no doc, because it actively misleads instead of leaving an honest gap.

When creating `CHANGELOG.md` for the first time, start it from the current change forward. Don't invent entries for past releases you weren't there for — a fabricated history is worse than starting the log today and saying so.
