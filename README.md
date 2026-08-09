# chai-agent

A personal AI assistant backend I own end-to-end — no third-party AI
extension, no vendor lock-in. One small Node.js/Express server, my own
skill instructions, and free-tier open-weight models routed through
[OpenRouter](https://openrouter.ai).

## Why this exists

I wanted a single backend for three things — general chat, search/research
questions, and coding help while working in VS Code — that:

- I fully control (my server, my routing logic, my prompt)
- Always applies my own instructions (`skills.md`) to every request
- Doesn't depend on a single paid model or vendor
- Is small enough to read top to bottom in a few minutes

No auth, no database, no framework beyond Express. It's built to be the
smallest thing that actually works, and easy to extend later.

## What it can do

- **Chat over HTTP** — `POST /api/chat` takes `{ message }`, returns
  `{ model, reply }`
- **Personal instructions on every request** — `skills.md` is read fresh
  from disk each time (no caching, no restart needed) and prepended as the
  system prompt
- **Quality-ranked free-model routing** — no single fixed model. Each
  request is classified as `coding` or `general` by keyword, then routed
  through a ranked list of known-good free OpenRouter models for that
  task type, with automatic fallback to the next model in the list on any
  error, rate limit (429), or empty reply — and a final fallback to
  OpenRouter's own free-models router so something always answers
- **Conversation memory** — the last ~10 turns are kept in memory so
  follow-up questions have context; `POST /api/reset` clears it
- **Two interfaces on the same backend**:
  - a plain HTML/CSS/JS chat page at `/` (scrolling messages, Reset button)
  - a CLI (`npm run chat`) for quick questions or an interactive REPL,
    without leaving the terminal
- **Visibility into what's actually answering** — every request appends a
  line to `logs/model-usage.jsonl` recording which model responded and how
  many models it took, so the ranked list in `models.config.js` can be
  tuned based on real performance instead of guessing

## How a request flows

```
your message
  → skills.md read fresh from disk, prepended as the system prompt
  → keyword check: coding-flavored words? → "coding" list, else → "general" list
  → try ranked free model #1 for that task type
      ok?  → done, log it, reply
      error / 429 / empty reply? → try ranked free model #2, then #3...
      all named models failed? → try "openrouter/free" (always answers)
  → reply returned to whichever client asked (browser or CLI)
```

## Project structure

```
.
├── server.js            Express app — /api/chat, /api/reset, routing + fallback logic
├── models.config.js      Ranked free-model lists per task type + keyword classifier
├── skills.md              Personal system instructions, read fresh every request
├── cli.js                 Terminal client — npm run chat (interactive or one-shot)
├── public/
│   └── index.html          Browser chat UI, served at /
├── logs/
│   └── model-usage.jsonl   Auto-generated: one line per request (model, task type, attempts)
├── .env.example            Template for your API key — copy to .env
└── .gitignore               Excludes node_modules/, .env, logs/
```

## Setup

```bash
npm install
cp .env.example .env
```

Then open `.env` and paste in your real OpenRouter API key
(get one at https://openrouter.ai/keys):

```
OPENROUTER_API_KEY=sk-or-v1-...
PORT=3000
```

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

**`skills.md`** — your personal instructions, prepended as the system
prompt on every request. Edit and save; no restart needed.

**`models.config.js`** — the ranked free-model lists and the coding/general
keyword classifier. ⚠️ Free-tier model IDs on OpenRouter change over time —
periodically check https://openrouter.ai/models?max_price=0 and update the
lists. Use `logs/model-usage.jsonl` to see which models are actually
performing well for you and manually re-rank them higher.

## License

MIT — see [LICENSE](LICENSE).
