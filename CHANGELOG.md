# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This log starts from today (2026-08-13) — earlier work wasn't logged as it
happened, and inventing entries for it after the fact would be worse than
an honest gap. Everything before this point lives in git history instead.

## [Unreleased]

## [0.3.0] - 2026-08-14

### Added
- Live tool-call transcript, streaming replies, markdown rendering, and
  a Stop button for the chat — replaces the old opaque "Thinking..."
  bubble with one that evolves in place through a turn (transcript lines
  as tool calls happen, streamed text, then the rendered final content —
  designed as one client-side `activeTurn` state object rather than
  three competing update paths):
  - `src/openrouter.ts` — `callOpenRouter` rewritten for SSE streaming
    (`response.body` read loop, `stream: true` +
    `stream_options: { include_usage: true }`), with concrete
    index-keyed reassembly of streamed tool-call argument fragments into
    complete JSON strings before they ever leave the file — `tools.ts`
    needed zero changes as a result. `callWithFallback` now discards a
    partial reply and restarts cleanly with the next model if a failure
    happens *after* some text already streamed, instead of letting a
    second model's answer visually run together with the first's
    orphaned fragment. New optional `signal`/`onDelta`/`onRestart` on
    `CallOptions`
  - `src/tools.ts` — `summarizeToolCall`/`summarizeToolResult` helpers
    for the transcript's one-line-per-call previews (never the full
    result — `read_file` can return an entire file)
  - `src/chatPanel.ts` — the tool-call loop now posts `toolStart`/
    `toolEnd` around each call instead of running fully hidden;
    `AbortController` wired through `handleSend` → `callModel` for Stop,
    gated by a `turnId` every extension→webview message during a turn
    now carries (a late message for an already-cancelled turn is
    dropped, not specially handled). Webview gets a hand-rolled,
    dependency-free markdown renderer (escape-first, fenced code blocks
    and inline code protected from later emphasis regexes via a
    placeholder-token swap, no link/image syntax, headers flattened to
    bold rather than real heading tags) — applies to assistant replies
    only, never per-streamed-chunk (once, at the final swap, to avoid
    flickering on an unclosed code fence mid-stream)
  - Send button doubles as Stop while a turn is in flight; the input box
    is now actually disabled during a turn too (previously only the send
    button was, so Enter could still fire a second send mid-request)

- Four features adapted from patterns in the official `claude-code`
  repo's examples/plugins (docs only — the CLI itself is closed-source),
  scoped to the VS Code extension only (`server.js`/`cli.js` have no
  tool-calling and nothing for these to gate):
  - `src/dangerousPatterns.ts` — deterministic scan for ~18 high-signal
    dangerous code patterns, folded into the write_file/edit_file
    approval dialog as a warning banner (modeled on claude-code's
    `security-guidance` plugin's regex layer, without its LLM-review
    layers). Still fires as a non-modal toast under "Always Allow"
  - `rizo.permissions.autoApproveCommandPatterns` and
    `rizo.permissions.disabledTools` VS Code settings — the extension's
    first `contributes.configuration` entry at all. Destructive commands
    stay non-overridable by either setting, on purpose
  - `src/projectInstructions.ts` — optional `.rizo/instructions.md` in
    the user's own workspace, appended after bundled skills, 8KB budget
  - `src/slashCommands.ts` — `/commit`, `/review`, `/test` expand to a
    canned prompt tied to the matching skill and force the coding tier

- A visible `// Rizo — Copyright (c) 2026 Chaitanya Aggarwal` header on
  every first-party source file (root + extension) — a plain-sight
  provenance marker, follow-up to the Commons Clause license change below
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

### Fixed
- The chat panel was completely unusable on load right after the
  markdown/streaming work above landed — no button worked, Enter
  inserted a newline instead of sending. Root cause: `getHtml()`'s
  returned page is itself the body of an outer TypeScript template
  literal, which processes its own backslash escapes in one pass before
  the inner webview script ever reaches a browser. Every `\n`/`\s`/`\d`/
  `\w`/`\*` written directly into `renderMarkdown` got silently
  corrupted by that outer pass (four placeholder tokens even ended up as
  literal NUL bytes, which HTML5 parsing replaces during tokenization).
  `node --check`/`require()` never caught it — reading a `.js` file
  bypasses HTML tokenization entirely. Rewrote `renderMarkdown` with
  zero backslash-escape sequences (character classes, `String.fromCharCode`
  for the newline) and reproduced the exact failure with `jsdom` to
  confirm the fix before shipping it again

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
