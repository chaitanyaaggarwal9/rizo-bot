# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This log starts from today (2026-08-13) — earlier work wasn't logged as it
happened, and inventing entries for it after the fact would be worse than
an honest gap. Everything before this point lives in git history instead.

## [Unreleased]

### Added
- `website/` — the marketing site (deploys to rizobot.com via Vercel,
  see `website/README.md`). Static HTML/CSS/JS, no framework. Hero
  features a live diagram of the actual task-routing mechanism rather
  than generic marketing art; content (routing table, pricing, safety
  list) is pulled directly from `vscode-extension/src/*.ts`, not
  aspirational copy. Palette and wordmark built from the real Rizo logo
  (teal `#009C96` sampled directly from the source file, not guessed)
- `vscode-extension/README.md` — the actual Marketplace listing page
  (features, getting-started link, license); didn't exist before, so
  `vsce package`/`publish` had nothing to show on the extension's page
- `repository`, `bugs`, `homepage`, `keywords` fields in
  `vscode-extension/package.json`, pointing at the now-public repo
- `.github/CODEOWNERS`, PR template, bug report + feature request issue
  templates, `dependabot.yml` (weekly grouped updates, root + extension +
  Actions), and a `stale-issues` workflow — shaped after Cline's own
  `.github/` setup, scaled down to what this repo actually has (no
  JetBrains/CLI/SDK targets, no test suite yet to gate on)

### Changed
- `vscode-extension/package.json`'s `description` reworded (dropped "Team",
  now leads with BYOK), `categories` gains `Chat`, `publisher` field is a
  placeholder (`PUBLISHER_ID_HERE`) pending a real Marketplace publisher id
- **License switched from proprietary "all rights reserved" back to
  Apache License 2.0**, and the repo/extension are going public — BYOK
  (bring your own OpenRouter key) means there's no shared account or
  billing surface to protect, and a public repo is how Cline earns the
  trust this project is trying to match. `package.json` license fields
  updated (`vscode-extension` drops `"private": true` too), CONTRIBUTING
  reframed to welcome outside PRs, ONBOARDING rewritten for
  Marketplace-install + self-serve OpenRouter signup instead of
  internal-team `.vsix` handoff
- Security audit ahead of public release: fixed a symlink-based
  path-traversal gap in `resolveSafePath()` (a symlink inside the
  workspace pointing outside it could lead `read_file`/`write_file`/
  `edit_file` off the workspace root — now resolved via
  `fs.realpathSync`) and closed two gaps in destructive-command
  detection (colon-refspec branch delete, long-form `rm --recursive
  --force`)

## [0.1.0] - 2026-08-13

### Added
- Rizo (the VS Code extension, `vscode-extension/`) renamed from "Chai Agent"
- Free/Paid model switcher — segmented toggle above the chat; free mode
  routes through the free-tier fallback chain and never touches a paid
  model, even for coding
- "Always Allow (this project)" option on non-destructive file-edit and
  command approvals, persisted per-workspace — destructive commands
  (force-push, hard reset, `branch -D`, `rm -rf`) are exempt and always
  ask, every time, with no bypass
- Per-reply token usage and elapsed time; running token count and
  estimated $ cost shown for the whole chat (free-tier replies always
  count as $0)
- Extension icon
- `.vsix` packaging via `npx vsce package`, and a team-facing onboarding
  doc (`vscode-extension/ONBOARDING.md`)
- Git Hygiene skill: new rule to check README/CHANGELOG/CONTRIBUTING are
  still accurate before every push (this file exists because of it)

### Changed
- Chat composer redesigned: single-line input → auto-growing textarea,
  icon-styled send button, refreshed message bubble styling
- Tool activity while the agent works is now fully hidden behind a plain
  "Thinking..." indicator instead of showing raw tool-call text — the
  approval prompts themselves are unchanged and still show full detail
- License switched from MIT to proprietary all-rights-reserved
- Repository renamed from `chai.agent` to `rizo-bot`
