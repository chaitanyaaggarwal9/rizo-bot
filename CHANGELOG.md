# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This log starts from today (2026-08-13) — earlier work wasn't logged as it
happened, and inventing entries for it after the fact would be worse than
an honest gap. Everything before this point lives in git history instead.

## [Unreleased]

### Added
- `.github/workflows/release.yml` — tag-triggered (`v*.*.*`) Marketplace
  publish: compiles, checks the tag matches `package.json`'s version,
  packages, publishes, attaches the `.vsix` to a GitHub Release. Needs a
  `VSCE_PAT` repo secret. See CONTRIBUTING.md for the release steps
- A custom mascot in the empty-state chat view, replacing the plain
  R-mark; source PNG had a solid black canvas, keyed out to transparent
  so it adapts to any VS Code theme
- Extension panel now shows the actual Rizo mark in its tab (`iconPath`
  was never set, so it fell back to plain text next to a generic icon)
- An empty-state view for a new/blank chat: centered mark, one-line hint,
  replacing the blank panel a first-time open used to show
- File attachments in the composer: "Attach file..." (any file on disk,
  via the OS picker) and "Mention file from this project..." (workspace
  quick pick). Text files fold into the message; images become real
  vision attachments (rendered as thumbnails in the chip tray and in the
  message bubble, not just a filename)
- Vision-capable routing: an attached image bumps low/medium tier to
  Gemini Flash for that request (Sonnet 5 already handles vision on the
  coding tier); free mode has no vision model in its chain yet, so an
  image there fails with a clear message instead of being silently
  dropped
- Per-chat summarization: once a thread passes 20 stored messages,
  everything older than the last 10 gets folded into a running summary
  (one cheap-tier call) instead of being replayed in full on every future
  turn. Every message is still stored and still shown in the UI, this
  only shrinks what gets sent to the model

### Changed
- Free/Paid switch dropped the 🆓/💰 emoji — text-only now, active state
  colored with the brand teal/amber instead of an icon standing in for
  what the label already says

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
  Actions), and a `stale-issues` workflow, scaled to what this repo
  actually has (no JetBrains/CLI/SDK targets, no test suite yet to gate on)

### Changed
- `vscode-extension/package.json`'s `description` reworded (dropped "Team",
  now leads with BYOK), `categories` gains `Chat`, `publisher` field is a
  placeholder (`PUBLISHER_ID_HERE`) pending a real Marketplace publisher id
- **License gains the Commons Clause**, on top of the Apache License 2.0
  it already switched to below: still free to use, read, modify, and
  redistribute, but the Commons Clause specifically withholds the right
  to sell the software (or a product/service whose value comes
  substantially from it) — makes the project source-available rather than
  OSI-certified "open source," which by definition can't restrict
  commercial use. `package.json` license fields (root + `vscode-extension`)
  changed to `SEE LICENSE IN LICENSE`, since Commons Clause has no
  registered SPDX identifier
- **License switched from proprietary "all rights reserved" back to
  Apache License 2.0**, and the repo/extension are going public — BYOK
  (bring your own OpenRouter key) means there's no shared account or
  billing surface to protect, and public source code is part of the
  trust a BYOK tool needs to earn. `package.json` license fields
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
