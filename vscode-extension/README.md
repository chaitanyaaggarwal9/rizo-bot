# Rizo

An AI coding assistant for VS Code: chat, file edits, and terminal/git commands, with cost-optimized, company-locked model selection. **BYOK**: bring your own [OpenRouter](https://openrouter.ai) API key, billed directly by OpenRouter for what you actually use.

## Features

**Chat**
- **Pick a provider, once per chat**: Claude, OpenAI, Gemini, Grok, DeepSeek, Qwen, Kimi, Mistral, Z.ai GLM, or Free. That choice locks in for the chat's whole life; the in-chat switcher only ever offers that same company's own variants (e.g. Claude's Haiku 4.5 / Sonnet 5 / Opus 5), never a different provider: one tool-calling convention and context window for the life of the conversation. Want a different company? Start a new chat
- **Effort dial**: a second pill next to the model switcher (Low / Medium / High, adjustable any time) controls how hard the current model thinks, independent of which model's answering, and maps to OpenRouter's unified `reasoning.effort` field
- **Usage you can see**: a running today's-tokens / this-month's-cost readout at the top of the panel, aggregated across every chat and every provider, resetting itself automatically at midnight and on the 1st; per-chat totals sit under the composer too
- **Live turn status**: while a turn's running, see which variant is actually answering, what it's doing right now, elapsed time, and a running token count, not just a static "Thinking..." bubble
- **Streaming replies with a live tool-call transcript**: see what's actually happening (which file, which command) as it happens
- **Markdown rendering**: code blocks, lists, bold/italic render properly in replies
- **Stop button**: cancel an in-flight reply any time
- **File & image attachments** (pick from disk, mention a workspace file, or paste an image straight from the clipboard), **multiple named threads** (renameable, deletable with a confirm dialog, and undoable via an "Undo" toast or the Reopen Closed Session command), and automatic summarization once a chat gets long
- **Message queueing**: type a follow-up while Rizo's still working; it sends once the current reply finishes instead of the input locking

**Smart routing**
- **Smart Starting Variant**: a chat's first message can start on a stronger variant than the cheapest default when it actually calls for it (a real bug report, a big refactor ask), based on a cheap heuristic, not an extra model call, and never overrides a variant you picked yourself
- **Effort auto-suggestion**: the same heuristic also picks Effort per turn, backing off permanently the moment you set it yourself
- **Auto-escalation**: a turn that visibly struggles (hits its step limit, keeps failing the same tool call, or stalls across turns without making progress) offers a one-click "Retry with a stronger variant" (still within the same company, only when a stronger one exists)
- **Free, your way**: Auto by default, or pick a specific free model yourself (from whichever companies actually publish one; no free Claude/Gemini exists) with its own Effort control where it supports one

**Safety & control**
- **File edits with approval**: every write shows a native diff view before anything touches disk; nothing happens without your click
- **Terminal & git tools**: with an elevated, non-bypassable warning on destructive commands (force-push, hard reset, branch deletion, `rm -rf`) or ones that hide what they actually run (piping a remote download into a shell, `bash -c "..."`, `eval`)
- **Security pattern-scan**: a proposed change is checked against dozens of known-dangerous patterns (`eval`, hardcoded secrets, disabled TLS checks, unsafe deserialization, etc.) and flagged right in the approval dialog, before you click
- **Command-output redaction**: API keys, tokens, and private keys that happen to show up in a command's output (an `.env` dump, `env`, `aws configure list`) are redacted before they ever reach the model or get stored in thread history
- **Configurable permissions**: auto-approve specific commands by pattern, or disable a tool entirely, via VS Code settings
- **Work outside the open folder, on purpose**: every folder in a multi-root workspace is usable, and naming a real path in your own message (never the model's own idea) grants access to it for the rest of that chat (same trust boundary file attachments already use)
- **Truncated writes fail informatively**: a large file cut off by the response size limit gets told to split into smaller calls, not a generic error that just triggers an identical, costly retry

**Shortcuts**
- **Slash commands**: `/commit`, `/review`, `/test` expand into a full guided prompt tied to house engineering discipline
- **Project instructions**: drop a `.rizo/instructions.md` in your workspace for project-specific rules, no fork required

## Getting started

See [ONBOARDING.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/vscode-extension/ONBOARDING.md) for the full setup walkthrough (get an OpenRouter key, first run, how approvals work).

Short version: install → `Cmd+Shift+P` / `Ctrl+Shift+P` → **"Rizo: Open Chat"** → paste your OpenRouter key when prompted → pick a provider for the chat.

## Use your own Azure AI Foundry deployments

Already pay for models on Azure? Run **Rizo: Connect Azure AI Foundry** from the Command Palette, enter your resource endpoint (for example `https://my-resource.openai.azure.com`) and API key, and pick your deployments. Then choose **Azure AI Foundry** when you start a chat. Requests go straight to your Azure resource with your key (stored in your OS keychain), and Azure bills you directly. Deployments need to support tool calling.

## Use your own Amazon Bedrock models

Run **Rizo: Connect Amazon Bedrock**, enter your AWS region and a Bedrock API key (Bedrock console, "API keys"), and pick your models. Newer models such as Claude usually need their cross-region inference profile id (for example `us.anthropic...`). Then choose **Amazon Bedrock** when you start a chat. Requests go straight to Bedrock in your region with your key (stored in your OS keychain), and AWS bills you directly. Models need to support tool use. Replies currently appear all at once rather than word by word.

## Use tools from MCP servers

Rizo can use tools from [Model Context Protocol](https://modelcontextprotocol.io) servers, for example GitHub, a database, or your docs. Run **Rizo: Add MCP Server**, give it a name, and enter either the command that starts a local server (`npx -y @modelcontextprotocol/server-github`) or the https URL of a remote one. Tokens a server needs go under `env` (local) or `headers` (remote) in the `rizo.mcp.servers` user setting:

```json
"rizo.mcp.servers": {
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }
  },
  "docs": { "url": "https://example.com/mcp" }
}
```

Rizo asks before every MCP tool call (once, or always for that tool in this workspace) and shows the arguments. Results are treated as untrusted and secrets in them are redacted. MCP tools are never used in Plan mode. Servers can only be added in your user settings, never by a workspace, so opening a repo can't start one. **Rizo: Show MCP Servers** shows each server's status and tools, restarts them, and resets your "always allow" choices.

## License

Apache License 2.0, modified by the [Commons Clause](https://commonsclause.com).
See [LICENSE](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/LICENSE).
Free to use, modify, and share; the Commons Clause withholds the right to
sell it. Source-available, not OSI-certified "open source."
