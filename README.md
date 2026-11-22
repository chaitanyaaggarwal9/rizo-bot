<div align="center">

# Rizo

**A bring-your-own-key AI coding assistant for VS Code.**

Chat with Claude, OpenAI, Gemini, Grok, DeepSeek, Qwen, Kimi, Mistral, Z.ai GLM or free models through your own OpenRouter key, or with your own Azure AI Foundry and Amazon Bedrock accounts. Rizo reads your code, edits files, runs commands and uses MCP tools, and asks before anything changes.

[![CI](https://github.com/chaitanyaaggarwal9/rizo-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/chaitanyaaggarwal9/rizo-bot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/chaitanyaaggarwal9/rizo-bot/actions/workflows/codeql.yml/badge.svg)](https://github.com/chaitanyaaggarwal9/rizo-bot/actions/workflows/codeql.yml)
[![License: Apache 2.0 + Commons Clause](https://img.shields.io/badge/license-Apache%202.0%20%2B%20Commons%20Clause-blue.svg)](LICENSE)

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ChaitanyaAggarwal.rizo)
![BYOK](https://img.shields.io/badge/BYOK-OpenRouter%20%7C%20Azure%20%7C%20Bedrock-0ea5e9)
![MCP](https://img.shields.io/badge/MCP-supported-8b5cf6)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Source available](https://img.shields.io/badge/source-available-10b981)

[Website](https://rizobot.com) · [Marketplace](https://marketplace.visualstudio.com/items?itemName=ChaitanyaAggarwal.rizo) · [Getting started](vscode-extension/ONBOARDING.md) · [Settings](docs/SETTINGS.md) · [Security model](docs/SECURITY-MODEL.md) · [Architecture](docs/ARCHITECTURE.md) · [Rizo Lang](https://github.com/chaitanyaaggarwal9/rizolang)

</div>

---

## Contents

- [Why Rizo?](#why-rizo)
- [What it can do](#what-it-can-do)
- [Getting started](#getting-started)
- [Models and providers](#models-and-providers)
- [Security model](#security-model)
- [Project status and roadmap](#project-status-and-roadmap)
- [Project structure](#project-structure)
- [Development](#development)
- [Contributing, security and license](#contributing-security-and-license)

## Why Rizo?

- **Your key, your bill.** Requests go to OpenRouter, Azure or Bedrock with your own credentials. There is no Rizo account, no middleman server and no markup. Every reply shows its tokens, and the panel shows today's tokens and this month's cost.
- **One company per chat.** You pick a provider when a chat starts and every model switch inside that chat stays within that company. Context, tool calling and pricing stay consistent for the whole conversation.
- **Cheap by default, strong when it matters.** A chat starts on its provider's cheaper model unless the first message clearly needs more. A reply that struggles offers a one-click retry on the strongest model of the same company.
- **Nothing changes without you.** Every file write shows a diff first, every command asks first, destructive commands always warn, and every reply's file changes can be undone.

## What it can do

| | |
|---|---|
| **Chat and agent** | Streams replies, reads and edits files, runs terminal and git commands, and keeps a task checklist for multi-step work. |
| **Search without approvals** | `search_files` (grep), `find_files` (glob) and `list_directory` stay inside the workspace, skip ignored and secret files, and need no approval. |
| **Code navigation** | `find_definition`, `find_references` and `call_hierarchy` use the workspace's language server, the same engine as Go to Definition. |
| **Plan mode** | Switch the composer to **Plan** and Rizo only reads and investigates, then proposes a plan. **Run this plan** carries it out. |
| **Undo a reply** | A reply that changed files gets an **Undo changes** button that restores them, and warns if you edited them since. |
| **MCP servers** | Use tools from Model Context Protocol servers (local or remote) that you configure. Every call asks first. |
| **Inline edit** | Select code, press `Cmd+Alt+K` (`Ctrl+Alt+K`), describe the change, then keep or undo it. |
| **Autocomplete** | Optional ghost-text suggestions as you type. Off by default because each one is a paid request. |
| **Skills and project notes** | Bundled engineering guidance loaded only when relevant, plus your own `.rizo/instructions.md`. |
| **Rizo Lang** | `.rz` files are highlighted and checked as you type with the project's own compiler, with a Fix with Rizo quick fix. Chats about Rizo Lang load its official spec, and the model checks its own `.rz` changes with `rizolang_check`. |
| **Slash commands** | `/commit`, `/review` and `/test` expand into full guided prompts. |
| **Attachments** | Attach files, mention workspace files, or paste images for vision models. |
| **Threads** | Named chats with history, automatic summarizing of long chats, and undo for deleted chats. |

## Getting started

1. Install **Rizo** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ChaitanyaAggarwal.rizo) (search "Rizo" in the Extensions view).
2. Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys), or connect Azure or Bedrock (below).
3. Open a folder you trust, run **Rizo: Open Chat** from the Command Palette, and paste your key when asked. It's stored in your OS keychain.
4. Pick a provider for the chat and start asking.

The full walkthrough is in [ONBOARDING.md](vscode-extension/ONBOARDING.md). Every setting and command is listed in [docs/SETTINGS.md](docs/SETTINGS.md).

## Models and providers

| Provider | How you pay | Models |
|---|---|---|
| Claude, OpenAI, Gemini, Grok, DeepSeek, Qwen, Kimi, Mistral, Z.ai GLM | Your OpenRouter key | A curated fast / everyday / strongest set for each, plus **More models** with the live OpenRouter catalog and prices |
| Free | Your OpenRouter key, no credit needed | Auto (picks per task, with fallbacks) or a specific free model |
| Azure AI Foundry | Your Azure resource and key | Your own deployments (**Rizo: Connect Azure AI Foundry**) |
| Amazon Bedrock | Your Bedrock API key | Your enabled models and inference profiles (**Rizo: Connect Amazon Bedrock**) |

Replies have no built-in length or step limit: a reply runs until the model finishes or you press **Stop**. You can set your own caps in `rizo.limits.*`.

## Security model

Rizo runs code and edits files on your machine, so it is built to need your consent and to limit what a repository can do to you. In short:

- **Trusted folders only.** Rizo is disabled in Restricted Mode, and a workspace can't change Rizo's security settings. Those are user settings only.
- **Approvals.** Writes and edits show a diff and ask. Commands ask, and destructive ones (force-push, `reset --hard`, `rm -rf`, piping downloads into a shell) always warn, even if you chose "Always Allow". Files that can turn on automation (`.vscode`, `.git`, `.github`, `.rizo`, `.npmrc` and others) always ask.
- **Boundaries.** Tools stay inside your workspace folders. Other folders need your explicit grant, and symlinks can't be used to escape.
- **Secrets.** `.env` files and keys need approval to read and are never searched or autocompleted. Credential environment variables are withheld from commands and MCP servers. Secrets in command and tool output are redacted.
- **Untrusted content.** Project notes need your approval for each version. MCP results and repository text are marked as untrusted for the model.
- **Supply chain.** Pinned dependencies with install scripts disabled, SHA-pinned GitHub Actions, CodeQL, dependency review, a malware scan, and Marketplace publishing through OIDC with no stored token.

Details are in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Project status and roadmap

Rizo is in active development. Released versions are on the Marketplace, and unreleased changes are in [CHANGELOG.md](CHANGELOG.md).

- **Done:** BYOK chat across 10 providers plus Azure and Bedrock, agent tools, plan mode, undo, MCP, inline edit, autocomplete, Rizo Lang support, and repository hardening.
- **Released:** 0.7.0 on the Marketplace, adding [Rizo Lang](https://github.com/chaitanyaaggarwal9/rizolang) support: syntax highlighting, the spec as a built-in skill, and compiler checks in the editor and for the model.

## Project structure

```
.
├── vscode-extension/      The extension (see docs/ARCHITECTURE.md for the module map)
│   ├── src/               TypeScript source, tests next to each module (*.test.ts)
│   ├── media/             Chat view: chat.html, chat.css, chat.js
│   ├── skills/            Bundled engineering guidance (Markdown)
│   ├── README.md          Marketplace page
│   └── ONBOARDING.md      User guide
├── website/               rizobot.com (static, deployed by Vercel)
├── docs/                  Architecture, settings reference, security model
├── .github/workflows/     CI, CodeQL, dependency review, malware scan, release
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE                Apache 2.0 + Commons Clause
```

## Development

```bash
cd vscode-extension
npm ci               # install scripts are disabled by .npmrc
npm run compile      # or npm run watch
npm test             # vitest
```

Press F5 in VS Code to open an Extension Development Host. Every CI run also uploads a ready-to-install build as the `rizo-vsix` artifact, so you can test a pull request without building locally. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and releases.

## Contributing, security and license

- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md), and open an issue before anything larger than a small fix. Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security:** report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
- **License:** Apache License 2.0 with the [Commons Clause](https://commonsclause.com) (see [LICENSE](LICENSE)). You may use Rizo, including at work, and read, modify and share it. You may not sell it, or sell a product or service whose value comes mainly from it. This makes Rizo **source-available** rather than open source in the OSI sense. Please don't use the "Rizo" name to imply that a fork is endorsed.

<div align="center">

Made by [Chaitanya Aggarwal](https://github.com/chaitanyaaggarwal9) · [rizobot.com](https://rizobot.com)

</div>
