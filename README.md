# Rizo

![VS Code Extension CI](https://github.com/chaitanyaaggarwal9/rizo-bot/actions/workflows/vscode-extension-ci.yml/badge.svg)

Rizo is a BYOK AI coding assistant for VS Code — chat, file edits, and
terminal/git commands, with cost-optimized, company-locked model
selection. Bring your own [OpenRouter](https://openrouter.ai) API key;
you're billed directly by OpenRouter for exactly what you use, nothing
more.

## Why this exists

Most AI coding assistants pick one model for everything, or auto-route
across companies in ways that lose context when the model changes
mid-task. Rizo's core bet is different: **cost-efficient routing that
never sacrifices continuity.**

- **Company-locked, not model-locked.** Pick Claude, Gemini, OpenAI,
  DeepSeek, Kimi, or Free once per chat. Every switch inside that chat
  stays within the same company's own variants — same tool-calling
  convention, same context window, same pricing model — never a
  different provider mid-task
- **Cheap by default, strong when it matters.** A new chat starts on
  its provider's cheapest variant; a lightweight heuristic can start it
  stronger when the first message actually calls for it, and offer a
  one-click escalation if a turn visibly struggles — see
  [Smart routing](#smart-routing) below
- **You own the key, you see the cost.** No vendor lock-in, no hidden
  markup — a running tokens/cost readout is always visible

## What it can do

### Core chat

- **Provider picker** (`src/providers.ts`) — a new chat opens with a
  one-time choice of company. That choice locks in for the thread's
  whole life (`ThreadData.provider`/`.model` in `src/threadStore.ts`)
  and the in-chat switcher only ever offers that same company's other
  variants, never a different one
- **Effort switcher** — a second pill (Low/Medium/High) maps to
  OpenRouter's unified `reasoning.effort` field — *how hard* the
  already-picked model thinks, never *which* model answers. Hidden
  entirely for a variant that doesn't support it
- **Agentic tools** (`src/tools.ts`) — `read_file` (auto-approved,
  read-only, reads the live editor buffer directly when a file's open
  with unsaved changes), `write_file`/`edit_file` (diff preview + modal
  approval before anything touches disk), `run_command` (approval-gated,
  with an elevated, non-bypassable warning for destructive-looking
  commands and for shell indirection that hides what's actually
  running). A live tool-call transcript shows each call as it happens,
  collapsible for the full input/output
- **Attachments** — any file via the OS picker, a workspace quick pick,
  or paste an image directly into the composer. Checked against the
  current variant's own vision support before sending
- **Streaming replies**, markdown rendering, a Stop button, message
  queueing while a turn is in flight, per-chat summarization once a
  thread gets long, and named/renameable/deletable threads with undo

### Smart routing

- **Smart Starting Variant** (`src/complexityEstimator.ts`) — a
  thread's first message picks which variant *within its already-locked
  provider* to start on, instead of always defaulting to the cheapest.
  A cheap keyword/shape heuristic (no extra model call) scores the
  message for coding-flavor, code blocks, stack traces, attachments,
  length, and "big ask" phrasing — runs once, only on the first
  message, and only when you haven't already picked a variant yourself
- **Effort auto-suggestion** (`effortForTier` in `src/providers.ts`) —
  reuses that same heuristic to also pick the Effort level, every turn
  rather than only the first (effort is a per-request parameter, not a
  thread-level trait). Backs off permanently the moment you pick an
  effort level yourself
- **Auto-escalation** (`src/struggleDetector.ts`) — when a turn shows
  real evidence of struggling (hits the tool-call iteration cap, keeps
  re-hitting the same failing tool call, or shows two turns in a row
  that both poked around with tools but never wrote anything), the
  reply carries a one-click "↑ Retry with {strongest variant}" button —
  never crossing companies, only offered when a stronger variant
  actually exists to switch to
- **Live turn status** — while a turn runs, its bubble shows which
  variant is actually answering, what it's doing right now, elapsed
  time, and a running token count — not just a static "thinking"
  placeholder

### Safety and cost visibility

- **Command-output redaction** (`src/outputRedaction.ts`) —
  `run_command`'s stdout/stderr is scanned for API keys, tokens, and
  private keys and redacted in place before the result ever reaches the
  model or gets written into thread history
- **Security pattern-scan on diffs** (`src/dangerousPatterns.ts`) —
  before a write/edit approval dialog, the proposed change is scanned
  for high-signal dangerous patterns (`eval(`, raw `innerHTML =`,
  unsafe deserialization, hardcoded-looking secrets, disabled TLS
  verification, etc.) and folded into the dialog as a warning banner
- **Configurable permissions** — `rizo.permissions
  .autoApproveCommandPatterns` (has no effect on destructive commands)
  and `rizo.permissions.disabledTools`
- **Cost visibility** (`src/pricing.ts`) — every reply shows tokens
  used and elapsed time; the chat as a whole and the extension overall
  both show running token/cost totals

### Personalization

- **Skills** (`src/skillsLoader.ts`, `vscode-extension/skills/`) —
  per-topic engineering-discipline instructions, selectively loaded by
  keyword match so a one-line question doesn't pay for the full
  instruction set
- **Project-specific instructions** (`src/projectInstructions.ts`) —
  an optional `.rizo/instructions.md` in your own workspace, read fresh
  every message and appended after the bundled skills
- **Slash commands** (`src/slashCommands.ts`) — `/commit`, `/review`,
  `/test` expand to a full canned prompt tied to the matching skill

## Project structure

```
.
├── vscode-extension/        Rizo itself — see below
├── website/                 Marketing site (rizobot.com) — see website/README.md
├── .github/workflows/       CI: extension build + test, tag-triggered release
├── LICENSE                  Apache License 2.0 + Commons Clause (no resale)
└── .gitignore
```

Inside `vscode-extension/`:

```
vscode-extension/
├── src/                  Extension source — one module per concern
│   ├── *.test.ts             Unit tests (vitest) for every pure-logic module
│   ├── chatPanel.ts           Webview host: panel lifecycle, the send/tool-call loop
│   ├── tools.ts                read_file / write_file / edit_file / run_command
│   ├── threadStore.ts          Thread persistence (VS Code global storage)
│   ├── providers.ts            The company/model catalog + Smart Starting Variant/effort mapping
│   ├── openrouter.ts           OpenRouter streaming client
│   └── ...                     See the file list above for the rest
├── skills/                Engineering-discipline instructions, bundled into the extension
├── package.json            Extension manifest — commands, settings, contributes
└── ONBOARDING.md           End-user install/usage guide
```

## Using it

See [`vscode-extension/ONBOARDING.md`](vscode-extension/ONBOARDING.md) —
install from the Marketplace, add your API key, go. Marketing site:
[`website/`](website/) (deploys to rizobot.com).

## Development

```bash
cd vscode-extension
npm install
npm run compile      # or `npm run watch` while developing
npm test             # unit tests (vitest)
```

Launch from VS Code's Run and Debug panel (`.vscode/launch.json` is
already set up) to open the Extension Development Host. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full dev/release workflow.

**Packaging a `.vsix` for distribution:**

```bash
cd vscode-extension
npx vsce package --allow-missing-repository
```

## Continuous integration

`.github/workflows/` runs on every push/PR to `main`:

- **`vscode-extension-ci.yml`** — installs, type-checks/builds
  (`npm run compile`), and runs the unit test suite (`npm test`)
  whenever `vscode-extension/` changes
- **`stale-issues.yml`** — labels issues stale after 60 days of no
  activity, closes them after 14 more; runs on a daily schedule
- **`release.yml`** — publishes to the Marketplace, tag-triggered
  (`v*.*.*`). Compiles, tests, refuses to run if the tag doesn't match
  `package.json`'s version. See [CONTRIBUTING.md](CONTRIBUTING.md) for
  the release steps

Dependabot (`.github/dependabot.yml`) opens a weekly grouped PR for
dependency updates.

## Contributing

Bug reports and feature requests: use the issue templates. Pull
requests: see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, and
open an issue first for anything beyond a small fix.

## License

Apache License 2.0, modified by the [Commons
Clause](https://commonsclause.com) — see [LICENSE](LICENSE). Free to use,
read, modify, and redistribute for any non-commercial purpose; the one
thing the Commons Clause withholds is the right to **sell** it — the
software itself, or a product/service whose value comes substantially
from it. Also don't use the "Rizo" name to imply endorsement of a fork.

This makes the project source-available rather than OSI-certified "open
source" (the official Open Source Definition doesn't permit restricting
commercial use) — full source stays public and forkable, resale just
isn't licensed. `vscode-extension/package.json`'s `license` field reads
`SEE LICENSE IN LICENSE` since Commons Clause has no registered SPDX
identifier.
