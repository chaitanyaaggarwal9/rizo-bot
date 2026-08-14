# Rizo

An AI coding assistant for VS Code — chat, file edits, and terminal/git commands, with cost-optimized model routing. **BYOK**: bring your own [OpenRouter](https://openrouter.ai) API key, billed directly by OpenRouter for what you actually use.

## Features

- **Cost-optimized routing** — requests are classified by task (trivial, general, coding) and routed to a model sized for that task instead of paying Claude-Sonnet-5 prices for "hi"
- **Free / Paid toggle** — switch to a free-tier model chain any time, no credit needed
- **File edits with approval** — every write shows a native diff view before anything touches disk; nothing happens without your click
- **Terminal & git tools** — with an elevated, non-bypassable warning on destructive commands (force-push, hard reset, branch deletion, `rm -rf`)
- **Multiple threads** — separate named conversations, each with their own history
- **Cost visibility** — running token count and estimated $ shown for the current chat

## Getting started

See [ONBOARDING.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/vscode-extension/ONBOARDING.md) for the full setup walkthrough (get an OpenRouter key, first run, how approvals work).

Short version: install → `Cmd+Shift+P` / `Ctrl+Shift+P` → **"Rizo: Open Chat"** → paste your OpenRouter key when prompted.

## License

Apache License 2.0, modified by the [Commons Clause](https://commonsclause.com)
— see [LICENSE](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/LICENSE).
Free to use, modify, and share; the Commons Clause withholds the right to
sell it. Source-available, not OSI-certified "open source."
