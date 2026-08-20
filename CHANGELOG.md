# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This log starts from today (2026-08-13) — earlier work wasn't logged as it
happened, and inventing entries for it after the fact would be worse than
an honest gap. Everything before this point lives in git history instead.

## [Unreleased]

## [0.4.5] - 2026-08-20

### Fixed
- `moonshotai/kimi-k2-turbo` was pulled from OpenRouter entirely —
  a real user's existing Kimi thread started hard-failing every send
  with "not a valid model ID." Replaced Kimi's whole lineup with what's
  actually live now (K2.5, K2 Thinking, K3) rather than patch just the
  one dead id: the other two tiers had also drifted close enough in
  price ($0.57/$2.30 vs $0.60/$2.50) to barely function as separate
  tiers anymore, and K3 (a new flagship, 4x the context window, ~5x the
  price of K2 Thinking) restores a real cheap-to-strong spread.
  Cross-checked every other provider's model ids against OpenRouter's
  live catalog at the same time — nothing else was stale.
- `chatPanel.ts`'s `handleSend` now self-heals a thread stuck on a
  since-invalidated model id: falls back to that provider's current
  default and persists it, instead of sending a request that's doomed
  to fail the same way on every future turn. This is what actually
  needed to happen — the catalog fix alone doesn't rescue an existing
  thread already holding a dead id in storage. This will happen again
  to some provider eventually (an upstream provider can rename/pull a
  model with no warning); now a thread just quietly recovers instead of
  staying broken until someone manually opens the model switcher.

## [0.4.4] - 2026-08-20

### Changed
- `coding-discipline.md` rule 2 replaced with a concrete 7-rung ladder
  (doesn't need to exist → already in this codebase → stdlib → native
  platform feature → already-installed dependency → one line → only
  then the minimum that works), in place of the old vaguer "build only
  what was asked for" bullets — same intent, now a checkable sequence.
  A deliberate corner cut with a known ceiling now ships with a
  comment naming that ceiling, instead of either silently cutting it
  or not cutting it at all.
- New rule 5 in the same file, "Let the code speak, don't pad the
  reply" — nothing previously said anything about reply length, only
  code structure. Completion tokens price 3-5x prompt tokens across
  every provider in `pricing.ts`, so unsolicited prose in the final
  answer is the more expensive place to be verbose. Doesn't touch
  explanation the user actually asked for.
- `debugging-discipline.md` rule 3 gains a "grep every caller before
  fixing" tactic — a concrete way to verify a fix lands at the shared
  root rather than one call site; the root-cause fix is usually also
  the smaller diff, not a tradeoff against it.
- Rewrote 9 already-pushed commit messages to drop a leftover
  `Co-Authored-By: Claude` trailer predating this repo's own
  attribution-off setting — tree content byte-identical before and
  after, only the messages changed. Ahead of making this repo public.

## [0.4.3] - 2026-08-19

### Added
- Smart starting variant (`src/complexityEstimator.ts`) — a thread's
  first message now picks which variant *within its already-locked
  provider* to start on, instead of always defaulting to that
  company's cheapest model. A cheap keyword/shape heuristic (no model
  call) scores the message for coding-flavor, code blocks, stack
  traces, attachments, length, and "big ask" phrasing
  (refactor/redesign/migrate/rewrite/etc.); runs once, only before a
  thread's first send, and only when the model is still sitting at
  the picker's own default — an explicit manual pick always wins over
  a guess.
- Auto-escalation retry — when a turn hits the tool-call iteration cap
  without finishing, keeps re-hitting the same failing tool call three
  times in a row before giving up, or (new) shows two turns in a row
  that both poked around with read-only tools without ever writing
  anything, the reply now carries a one-click "↑ Retry with {strongest
  variant}" button (only shown when there's actually a stronger
  variant left in that provider to offer). Clicking it reuses the
  existing model-switcher's own code path to re-lock the thread to
  that variant, then resends — same company-lock rule as everywhere
  else, no cross-provider escalation. The cross-turn signal
  (`src/struggleDetector.ts`) closes a real gap the first two missed:
  a cheap model that writes a broken multi-file page (e.g. an HTML
  file linking a stylesheet/script it never created) and then spends
  several turns re-checking the same missing file instead of writing
  it — zero tool errors, nowhere near the iteration cap, invisible to
  either single-turn signal.
- Effort auto-suggestion (`providers.ts`'s `effortForTier`) — reuses
  Smart Starting Variant's same message-complexity tier to also pick
  the Effort level (low/medium/high) for a turn's `reasoning.effort`.
  Unlike the model pick, this isn't a thread-level identity trait, so
  it re-evaluates on *every* turn rather than only the first, and
  never writes the guess back to thread storage — only used for that
  turn's own call and reflected live on the Effort pill. Permanently
  deferred the moment you ever pick an effort level yourself from the
  switcher (same "an explicit choice always wins over a guess" rule as
  everywhere else), and skipped outright for a variant that ignores
  effort entirely (the Free provider's one Auto model).
- Live turn status line — while a turn is running, its bubble now shows
  which model/variant is actually answering, what it's doing right now
  ("Thinking…", the current tool call's title, "Writing reply…"), a
  ticking elapsed timer, and a running token count that grows across a
  turn's tool round-trips — all previously invisible until the whole
  turn finished. Cleaned up on every path that can end a turn — normal
  finish, Stop, an error, switching threads — so nothing keeps ticking
  against a turn nobody's looking at anymore.
- A real unit test suite (`vitest`, `src/*.test.ts`) covering every
  module with no `vscode` import at module level — task classification,
  Smart Starting Variant/effort selection, destructive-command
  detection, dangerous-pattern scanning, secret redaction, pricing,
  slash commands, and struggle detection. Wired into CI
  (`vscode-extension-ci.yml`) and as a pre-publish gate
  (`release.yml`). `npm test` / `npm run test:watch`.

### Fixed
- SSE stream parsing (`src/openrouter.ts`) rewritten to actually follow
  the spec: one event's data can legitimately be spread across several
  consecutive `data:` lines, meant to be joined with `\n` and parsed
  once a blank line ends the event. The old parser treated every single
  `data:` line as a complete, independently-parseable JSON chunk on its
  own — which happened to work for the common one-line-per-event case,
  but silently dropped a chunk of a streamed tool call's arguments the
  moment a payload was ever legitimately spread across multiple lines
  this way. Root cause of a real, reproducible "could not parse tool
  arguments as JSON" failure: a large `write_file` call (e.g. a
  multi-hundred-line HTML/CSS/JS game file) kept failing and getting
  silently regenerated from scratch on every retry, burning full
  generation tokens each time. `tools.ts`'s error message for a
  genuine (non-framing) JSON failure also no longer dumps the entire
  raw argument blob back into the tool result — a short excerpt plus
  JSON.parse's own error and a concrete "try smaller calls" suggestion
  instead, so a real failure doesn't also inflate the next turn's input
  tokens for nothing.
- `coding-discipline.md` (the base skill loaded on every coding-
  classified message) now explicitly says a page whose stylesheet or
  script was never written isn't done, and to create every file
  referenced in the same turn rather than waiting to be asked — the
  direct fix for the transcript that motivated the cross-turn
  stagnation signal above.

### Changed
- Removed the separate root-level Express/CLI backend (`server.js`,
  `cli.js`, `models.config.js`, `skills.config.js`, `public/`, root
  `skills/`) — an older personal prototype that predated the VS Code
  extension and had gone unmaintained since. Rizo (`vscode-extension/`)
  is now the only product in this repo; `README.md`/`CONTRIBUTING.md`/
  `.github/` updated throughout to match, and the backend-only
  `ci.yml` workflow and its Dependabot entry are gone with it.

## [0.4.2] - 2026-08-19

### Added
- Command-output redaction (`src/outputRedaction.ts`) — `run_command`'s
  stdout/stderr is scanned for API keys, tokens, JWTs, and private keys
  and redacted in place (e.g. `API_KEY=[REDACTED]`) before the result
  ever reaches the model or gets written into thread history. Covers
  this extension's own kind of key (`sk-or-v1-...`) along with GitHub,
  AWS, and generic labeled secrets — the gap this closes: unlike a
  command's own text, which gets an approval prompt before it runs, its
  *output* had no review step at all, so `cat .env`, `env`, or
  `aws configure list` flowed straight into the conversation with zero
  scrubbing
- `destructiveCommands.ts` now also flags shell indirection as
  destructive — piping a remote download into `sh`/`bash`/`zsh`,
  `bash -c "..."`, `base64 -d | sh`, `eval` — none of which the existing
  force-push/rm-rf/hard-reset patterns could see into, so a destructive
  command run this way previously fell through to the casual,
  Always-Allow-bypassable approval tier instead of the elevated,
  non-bypassable one

Both came out of a security-review pass looking specifically at what
Codex's and Claude Code's own shipped security layers cover that
Rizo's didn't yet (checked their actual settings schema and, for
Codex, its real open-source `execpolicy` policy engine) — scoped down
to what's proportionate for this project's size rather than attempting
their full OS-level command sandboxing, which neither extension's
approach would be a reasonable solo-maintainer undertaking to replicate.

## [0.4.1] - 2026-08-19

### Added
- Message queueing — the composer no longer disables while a turn is
  running; typing a follow-up and hitting Enter queues it instead of
  doing nothing, auto-dispatching once the current reply finishes. Stop
  clears the queue instead of draining it. A small note above the
  composer shows how many are waiting
- Settings panel (gear icon in the thread bar): change your OpenRouter
  API key without clearing it first, Enter vs Ctrl/Cmd+Enter to send
  (`rizo.composer.sendKey`), a Focus view toggle that hides the tool-call
  transcript (`rizo.view.focusMode`), and a link into VS Code's native
  settings for the rest
- Reopen Closed Session — deleting a thread now shows an Undo toast, plus
  a standing `Rizo: Reopen Closed Session` command
- "Add File to Rizo Thread" — right-click a file in the Explorer or an
  editor tab to attach it, instead of only the composer's `+` menu
- TODO CodeLens — "Implement with Rizo" above `TODO`/`FIXME` comments in
  any file, prefills the composer (deliberately doesn't auto-send)

### Changed
- "Mention file from this project..." now respects the workspace's root
  `.gitignore`, not just a hardcoded node_modules/.git/out/dist/build list
- `read_file`/`write_file`/`edit_file` now read a file's live editor
  buffer directly when one's open, instead of only ever seeing
  saved-on-disk content
- This repo's own commits/PRs no longer carry a Co-Authored-By trailer
  (`.claude/settings.json`'s `attribution` setting)

### Fixed
- A QA pass (code-review + a dedicated security-review, run against
  everything above before it shipped) caught and fixed 8 issues: a
  Settings-panel toggle mid-turn could silently drop an in-flight reply
  and let two turns run concurrently on the same thread; the TODO
  CodeLens command crashed if triggered from the Command Palette instead
  of an actual CodeLens; the `.gitignore` glob conversion missed
  directory entries without a trailing slash (the common style); an
  older, still-visible "Undo" toast could restore the wrong thread after
  a second delete; `handleSend` could save a reply into the wrong
  thread's file if the active thread changed mid-turn; right-clicking a
  folder for "Add File to Thread" produced a raw EISDIR error; the TODO
  CodeLens didn't refresh when its setting was toggled off; and a file's
  autosave-before-write could persist an unrelated draft to disk even
  when the user clicked "Reject" on the actual proposed change

## [0.4.0] - 2026-08-14

### Changed
- Model selection is now an explicit, per-chat, company-locked choice
  instead of automatic per-message routing — the keyword/word-count
  classifier that used to pick a model turn-by-turn (`modelForMessage` in
  `modelRouter.ts`) was reclassifying every message in isolation, with no
  memory of an in-progress task; a short follow-up like "do it" could fall
  to the cheapest tier mid-edit, and the next turn's model had no ground
  truth for what a *different* model had already changed on disk.
  - `src/providers.ts` (new) — the company/variant catalog (Claude,
    Gemini, OpenAI, DeepSeek, Kimi, Free), ordered cheapest → most capable
    per company
  - A new chat now opens a provider picker instead of going straight to
    the composer; picking a company locks the thread to it
    (`ThreadData.provider`/`.model` in `threadStore.ts`) and starts on
    that company's cheapest variant. The in-chat model pill/dropdown only
    ever offers that same company's other variants — there is no code
    path that renders a different provider into it, and no way to cross
    providers mid-thread; a different company means a new chat
  - `src/modelRouter.ts` simplified accordingly — `TaskType` is now just
    `'coding' | 'general'` (the old `low`/`medium` reasoning-effort split
    only ever fed model selection, which is gone), and it's used solely to
    decide which skill files load (`skillsLoader.ts`) and, for the Free
    provider only, which fallback chain to try — never which model
    answers
  - `src/pricing.ts` extended with per-million-token pricing for every
    variant across all five companies
  - Header now shows a running "today's tokens / this month's cost"
    readout, top-right, aggregated across every thread and provider
    (`src/usageStore.ts`, new) — resets itself lazily (no cron/startup
    hook) whenever the stored day/month no longer matches the current one
  - The tool-call-iteration-limit placeholder reply is no longer a vague
    "(no final response...)" string — since it gets persisted and replayed
    as real history to whichever model answers the next turn, it now
    explicitly says the turn was cut short and invites "continue"

### Added
- Effort switcher — a second pill next to the model pill (Low/Medium/High,
  defaulting to Medium) that maps straight to OpenRouter's unified
  `reasoning.effort` field (`ReasoningEffort` in `openrouter.ts`), which
  OpenRouter itself translates into whatever the underlying provider
  actually expects (a literal effort enum for OpenAI-style models, a
  thinking-token budget for Anthropic/Gemini). This is the token-cost dial
  for *how hard the current model thinks*, independent of *which* model is
  answering (the provider/variant switcher from above) — so a thread can
  stay on one model the whole time and still cost less on trivial
  follow-ups. `ModelVariant.reasoning` in `providers.ts` marks the rare
  variant that doesn't support it (currently only the Free provider's
  rotating Auto model) — the pill hides entirely rather than offering a
  control that would silently do nothing. Stored per-thread
  (`ThreadData.effort` in `threadStore.ts`), adjustable anytime
- **Delete** button next to Rename in the thread bar — modal confirm first
  (`vscode.window.showWarningMessage`, no "Always" bypass), since there's
  no undo. Deleting the active thread falls back to the next
  most-recently-updated one, or a brand-new thread if that was the last
  one left (`deleteThread` in `threadStore.ts`)
- Usage readout ("Today: N tok · Month: $X") moved from the top-right
  corner into its own row, top-left, directly above the thread dropdown —
  same data (`usageStore.ts`), just relocated so it reads as "here's what
  this app is costing you" rather than competing for attention with the
  thread controls next to it

### Changed
- `vscode-extension/README.md`, `ONBOARDING.md`, and the root `README.md`
  updated to describe the provider picker / effort switcher / usage
  tracking above — replaces every mention of the old automatic
  trivial/general/coding classifier and the Free/Paid toggle, which no
  longer exist
- `website/` refreshed to match: hero, the former three-tier routing
  table, and the Free/Paid toggle section all described behavior that no
  longer exists. Now: a six-provider table (`#providers`), an Effort
  section reusing the old toggle-mock's visual pattern relabeled Low/
  Medium/High (`#effort`), and a new `#interface` section with two
  honestly-labeled screenshot placeholders (no real image-generation tool
  available — see `website/README.md` for which two files fill them in).
  Dead CSS for the removed tier pills and the old two-state toggle
  (`.pill-coding`/`.pill-general`/`.pill-trivial`, `.toggle-mock
  .active-paid`/`.active-free`, `.dot-paid`/`.dot-free`) removed or
  renamed to match. The two `#interface` placeholders were later filled
  in with real screenshots of the running extension
- `website/` hero diagram extended to four sequential stages (New chat →
  Pick a provider → Claude, locked in → which variant answers) instead
  of jumping straight to the locked-in state — it was skipping the two
  steps that are actually the point. Hero also gained a real two-column
  layout at ≥860px (text + the extension's own mascot image, same teal
  drop-shadow treatment as its empty-state), replacing a large area of
  unused whitespace next to a headline the existing `max-width: 15ch`
  rule wrapped narrower than intended

## [0.3.1] - 2026-08-14

### Changed
- Marketplace Overview (`vscode-extension/README.md`) updated for
  everything shipped in 0.3.0 — it had gone out with the 0.2.0 feature
  list still in place. `v0.3.0`'s tag was already pushed and protected
  (can't be moved/deleted on this repo) by the time this was caught, so
  it ships as its own patch release rather than retroactively changing
  what `v0.3.0` points to

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
