# Rizo

An AI coding assistant for VS Code — chat, file edits, and terminal/git commands, with cost-optimized, company-locked model selection. **BYOK**: bring your own [OpenRouter](https://openrouter.ai) API key, billed directly by OpenRouter for what you actually use.

## Features

**Chat**
- **Pick a provider, once per chat** — Claude, Gemini, OpenAI, DeepSeek, Kimi, or Free. That choice locks in for the chat's whole life; the in-chat switcher only ever offers that same company's own variants (e.g. Claude's Haiku 4.5 / Sonnet 5 / Opus 5), never a different provider — one tool-calling convention and context window for the life of the conversation, want a different company, start a new chat
- **Effort dial** — a second pill next to the model switcher (Low / Medium / High, adjustable any time) controls how hard the current model thinks, independent of which model's answering — maps to OpenRouter's unified `reasoning.effort` field
- **Usage you can see** — a running today's-tokens / this-month's-cost readout at the top of the panel, aggregated across every chat and every provider, resetting itself automatically at midnight and on the 1st; per-chat totals sit under the composer too
- **Live turn status** — while a turn's running, see which variant is actually answering, what it's doing right now, elapsed time, and a running token count, not just a static "Thinking..." bubble
- **Streaming replies with a live tool-call transcript** — see what's actually happening (which file, which command) as it happens
- **Markdown rendering** — code blocks, lists, bold/italic render properly in replies
- **Stop button** — cancel an in-flight reply any time
- **File & image attachments** (pick from disk, mention a workspace file, or paste an image straight from the clipboard), **multiple named threads** (renameable, deletable with a confirm dialog — and undoable, via an "Undo" toast or the Reopen Closed Session command), and automatic summarization once a chat gets long
- **Message queueing** — type a follow-up while Rizo's still working; it sends once the current reply finishes instead of the input locking

**Smart routing**
- **Smart Starting Variant** — a chat's first message can start on a stronger variant than the cheapest default when it actually calls for it (a real bug report, a big refactor ask), based on a cheap heuristic, not an extra model call — and never overrides a variant you picked yourself
- **Effort auto-suggestion** — the same heuristic also picks Effort per turn, backing off permanently the moment you set it yourself
- **Auto-escalation** — a turn that visibly struggles (hits its step limit, keeps failing the same tool call, or stalls across turns without making progress) offers a one-click "Retry with a stronger variant" — still within the same company, only when a stronger one exists

**Safety & control**
- **File edits with approval** — every write shows a native diff view before anything touches disk; nothing happens without your click
- **Terminal & git tools** — with an elevated, non-bypassable warning on destructive commands (force-push, hard reset, branch deletion, `rm -rf`) or ones that hide what they actually run (piping a remote download into a shell, `bash -c "..."`, `eval`)
- **Security pattern-scan** — a proposed change is checked against dozens of known-dangerous patterns (`eval`, hardcoded secrets, disabled TLS checks, unsafe deserialization, etc.) and flagged right in the approval dialog, before you click
- **Command-output redaction** — API keys, tokens, and private keys that happen to show up in a command's output (an `.env` dump, `env`, `aws configure list`) are redacted before they ever reach the model or get stored in thread history
- **Configurable permissions** — auto-approve specific commands by pattern, or disable a tool entirely, via VS Code settings

**Shortcuts**
- **Slash commands** — `/commit`, `/review`, `/test` expand into a full guided prompt tied to house engineering discipline
- **Project instructions** — drop a `.rizo/instructions.md` in your workspace for project-specific rules, no fork required

## Getting started

See [ONBOARDING.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/vscode-extension/ONBOARDING.md) for the full setup walkthrough (get an OpenRouter key, first run, how approvals work).

Short version: install → `Cmd+Shift+P` / `Ctrl+Shift+P` → **"Rizo: Open Chat"** → paste your OpenRouter key when prompted → pick a provider for the chat.

## License

Apache License 2.0, modified by the [Commons Clause](https://commonsclause.com)
— see [LICENSE](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/LICENSE).
Free to use, modify, and share; the Commons Clause withholds the right to
sell it. Source-available, not OSI-certified "open source."
