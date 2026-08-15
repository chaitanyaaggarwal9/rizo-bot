# Rizo

An AI coding assistant for VS Code — chat, file edits, and terminal/git commands, with cost-optimized model routing. **BYOK**: bring your own [OpenRouter](https://openrouter.ai) API key, billed directly by OpenRouter for what you actually use.

## Features

**Chat**
- **Cost-optimized routing** — requests are classified by task (trivial, general, coding) and routed to a model sized for that task instead of paying Claude-Sonnet-5 prices for "hi"
- **Free / Paid toggle** — switch to a free-tier model chain any time, no credit needed
- **Streaming replies with a live tool-call transcript** — see what's actually happening (which file, which command) as it happens, instead of a blank "Thinking..." bubble
- **Markdown rendering** — code blocks, lists, bold/italic render properly in replies
- **Stop button** — cancel an in-flight reply any time
- **File & image attachments**, **multiple named threads**, running **cost/token visibility**, and automatic summarization once a chat gets long

**Safety & control**
- **File edits with approval** — every write shows a native diff view before anything touches disk; nothing happens without your click
- **Terminal & git tools** — with an elevated, non-bypassable warning on destructive commands (force-push, hard reset, branch deletion, `rm -rf`)
- **Security pattern-scan** — a proposed change is checked against ~18 known-dangerous patterns (`eval`, hardcoded secrets, disabled TLS checks, etc.) and flagged right in the approval dialog, before you click
- **Configurable permissions** — auto-approve specific commands by pattern, or disable a tool entirely, via VS Code settings

**Shortcuts**
- **Slash commands** — `/commit`, `/review`, `/test` expand into a full guided prompt tied to house engineering discipline
- **Project instructions** — drop a `.rizo/instructions.md` in your workspace for project-specific rules, no fork required

## Getting started

See [ONBOARDING.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/vscode-extension/ONBOARDING.md) for the full setup walkthrough (get an OpenRouter key, first run, how approvals work).

Short version: install → `Cmd+Shift+P` / `Ctrl+Shift+P` → **"Rizo: Open Chat"** → paste your OpenRouter key when prompted.

## License

Apache License 2.0, modified by the [Commons Clause](https://commonsclause.com)
— see [LICENSE](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/LICENSE).
Free to use, modify, and share; the Commons Clause withholds the right to
sell it. Source-available, not OSI-certified "open source."
