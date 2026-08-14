# chai-agent

![Server CI](https://github.com/chaitanyaaggarwal9/chai.agent/actions/workflows/ci.yml/badge.svg)
![VS Code Extension CI](https://github.com/chaitanyaaggarwal9/chai.agent/actions/workflows/vscode-extension-ci.yml/badge.svg)

A personal AI assistant backend I own end-to-end — no third-party AI
extension, no vendor lock-in. One small Node.js/Express server, my own
skill instructions, and free-tier open-weight models routed through
[OpenRouter](https://openrouter.ai) — plus a VS Code extension that brings
the same routing and skills into the editor for the team.

## Why this exists

I wanted a single backend for three things — general chat, search/research
questions, and coding help while working in VS Code — that:

- I fully control (my server, my routing logic, my prompt)
- Always applies my own instructions (`skills/`) to every request
- Doesn't depend on a single paid model or vendor
- Is small enough to read top to bottom in a few minutes

No auth, no database, no framework beyond Express. It's built to be the
smallest thing that actually works, and easy to extend later.

## What it can do

- **Chat over HTTP** — `POST /api/chat` takes `{ message }`, returns
  `{ model, reply }`
- **Personal instructions on every request, split by topic** — skill files
  under `skills/` are read fresh from disk each time (no caching, no
  restart needed). `skills.config.js` decides which ones apply: general/
  non-coding requests load none, coding requests get the `coding-
  discipline` base layer plus whichever specific topics (debugging, git,
  API, testing) match via word-boundary keyword matching — so a one-line
  question doesn't pay for the full instruction set in its system prompt
- **Quality-ranked free-model routing** — no single fixed model. Each
  request is classified as `coding` or `general` by keyword (word-boundary
  matched, so "capital" doesn't misfire on "api"), then routed through a
  ranked list of known-good free OpenRouter models for that task type,
  with automatic fallback to the next model in the list on any error,
  rate limit (429), or empty reply — and a final fallback to OpenRouter's
  own free-models router so something always answers
- **Conversation memory** — the last ~10 turns are kept in memory so
  follow-up questions have context; `POST /api/reset` clears it
- **Three interfaces on the same backend**:
  - a plain HTML/CSS/JS chat page at `/` (scrolling messages, Reset button)
  - a CLI (`npm run chat`) for quick questions or an interactive REPL,
    without leaving the terminal
  - a VS Code extension (`vscode-extension/`) for the team — see
    [VS Code extension](#vs-code-extension) below
- **Visibility into what's actually answering** — every request appends a
  line to `logs/model-usage.jsonl` recording which model responded and how
  many models it took, so the ranked list in `models.config.js` can be
  tuned based on real performance instead of guessing

## How a request flows

```
your message
  → keyword check: coding-flavored words? → "coding" list, else → "general" list
  → matching skill files under skills/ read fresh from disk, joined and
    prepended as the system prompt (none for general requests)
  → try ranked free model #1 for that task type
      ok?  → done, log it, reply
      error / 429 / empty reply? → try ranked free model #2, then #3...
      all named models failed? → try "openrouter/free" (always answers)
  → reply returned to whichever client asked (browser, CLI, or the VS Code extension)
```

## Project structure

```
.
├── server.js               Express app — /api/chat, /api/reset, routing + fallback logic
├── models.config.js        Ranked free-model lists per task type + keyword classifier
├── skills.config.js        Decides which skill file(s) apply per request, by keyword
├── skills/
│   ├── coding-discipline.md      Base layer for every coding-classified request
│   ├── debugging-discipline.md
│   ├── git-hygiene.md
│   ├── backend-api-taste.md
│   └── test-discipline.md
├── cli.js                  Terminal client — npm run chat (interactive or one-shot)
├── public/
│   └── index.html            Browser chat UI, served at /
├── logs/
│   └── model-usage.jsonl     Auto-generated: one line per request (model, task type, attempts)
├── vscode-extension/        Standalone VS Code extension — see below
├── .github/workflows/       CI: server sanity checks + extension build
├── LICENSE                  Proprietary, all rights reserved
└── .gitignore                Excludes node_modules/, .env, logs/, .DS_Store
```

## Setup

```bash
npm install
```

Create a `.env` file in the project root with your OpenRouter API key
(get one at https://openrouter.ai/keys):

```
OPENROUTER_API_KEY=sk-or-v1-...
PORT=3000
```

`.env` is gitignored — it never gets committed.

## Running it

Start the server:

```bash
node server.js
```

**Browser:** open http://localhost:3000

**CLI**, in a separate terminal (server must be running):

```bash
npm run chat                        # interactive REPL — type messages, "reset" to clear, "exit" to quit
npm run chat -- "your question"     # one-shot — sends, prints reply, exits
npm run chat -- --reset             # clears conversation memory and exits
```

**Reset conversation memory** directly via the API:

```bash
curl -X POST http://localhost:3000/api/reset
```

## Configuration

**`skills/*.md`** — your personal instructions, split by topic and
prepended as the system prompt on every request. Edit and save; no
restart needed. `skills.config.js` controls which files load for which
requests (see `SKILL_KEYWORDS` there to add or retune topics).

**`models.config.js`** — the ranked free-model lists and the coding/general
keyword classifier. ⚠️ Free-tier model IDs on OpenRouter change over time —
periodically check https://openrouter.ai/models?max_price=0 and update the
lists. Use `logs/model-usage.jsonl` to see which models are actually
performing well for you and manually re-rank them higher.

## VS Code extension

`vscode-extension/` is a standalone team-facing extension — same chat-
over-OpenRouter idea, brought into the editor with an agentic tool-use
loop:

- **Model routing** (`src/modelRouter.ts`) — messages classify into
  low/medium/coding tiers; coding is hard-pinned to Claude Sonnet 5,
  low/medium route to cost-optimized models by keyword signal, falling
  back to word count
- **Skills** (`src/skillsLoader.ts`, `skills/`) — the same per-topic,
  selectively-loaded approach as the server, bundled so every teammate
  gets identical instructions
- **Agentic tools** (`src/tools.ts`) — `read_file` (auto-approved,
  read-only), `write_file`/`edit_file` (diff preview + modal approval
  before anything touches disk), `run_command` (approval-gated, with an
  elevated warning for destructive-looking commands like force-push,
  hard reset, `branch -D`, `rm -rf`)
- **Threads** (`src/threadStore.ts`) — named conversations persisted to
  VS Code's global storage, auto-titled, switchable from the panel
- Per-teammate OpenRouter keys are stored via VS Code Secret Storage,
  never in a file

Build it locally:

```bash
cd vscode-extension
npm install
npm run compile      # or `npm run watch` while developing
```

Then launch it from VS Code's Run and Debug panel (`.vscode/launch.json`
is already set up) to open the Extension Development Host.

## Continuous integration

`.github/workflows/` runs on every push/PR to `main`:

- **`ci.yml`** — installs the root project's dependencies and syntax-checks
  `server.js`, `cli.js`, `models.config.js`, and `skills.config.js`
- **`vscode-extension-ci.yml`** — installs and type-checks/builds the VS
  Code extension (`npm run compile`) whenever `vscode-extension/` changes

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE). Not licensed
for redistribution (`package.json`'s `"license": "UNLICENSED"`).
