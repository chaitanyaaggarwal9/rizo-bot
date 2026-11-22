# Rizo

An AI coding assistant for VS Code that uses **your own key**. Chat with Claude, OpenAI, Gemini, Grok, DeepSeek, Qwen, Kimi, Mistral, Z.ai GLM or free models through [OpenRouter](https://openrouter.ai), or with your own Azure AI Foundry and Amazon Bedrock accounts. Rizo reads your code, edits files, runs commands and uses MCP tools, and asks before anything changes.

## Features

**Chat and models**
- **One provider per chat.** Pick a company when a chat starts. The model switcher then offers only that company's fast, everyday and strongest models, plus **More models** from the live OpenRouter catalog with prices.
- **Effort control** (Low, Medium, High) for models that can think harder, adjustable at any time.
- **Starts cheap, escalates when needed.** A chat starts on a cheaper model unless the first message clearly needs more, and a reply that struggles offers a one-click retry on the strongest model.
- **No reply limits by default.** A reply runs until the model is done or you press Stop. Set your own caps if you want them.
- **See what you spend.** Tokens for each reply, totals for each chat, and today's tokens and this month's cost across all chats.

**Agent**
- **Edits with a diff first**, and commands only with your approval. Destructive commands always warn.
- **Fast, approval-free search:** search text across the workspace, find files by pattern, and list folders. Ignored, binary and secret files are skipped.
- **Code navigation** through your language server: definitions, references and call hierarchy.
- **Plan mode:** Rizo only reads and investigates, then proposes a plan you can run with one click.
- **Undo a reply:** restore every file a reply changed, with a warning if you edited them since.
- **Task checklist** for multi-step work, shown live in the chat.
- **MCP servers:** use tools from Model Context Protocol servers you set up, with approval for every call.

**In the editor**
- **Inline edit:** select code, press `Cmd+Alt+K` (`Ctrl+Alt+K`), describe the change, then keep or undo it.
- **Autocomplete** (off by default): suggestions as you type, accepted with `Tab`.
- **Implement with Rizo** above TODO and FIXME comments.

**Context**
- Attach files, mention workspace files, or paste images for vision models.
- Bundled engineering skills (coding, debugging, testing, security, git, code review and more), loaded only when relevant.
- Your own project rules in `.rizo/instructions.md`, used after you approve them.
- Slash commands: `/commit`, `/review`, `/test`.
- Named chats, automatic summarizing of long chats, and undo for a deleted chat.

## Getting started

1. Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys). Free models need no credit.
2. Open a folder you trust, then run **Rizo: Open Chat** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
3. Paste your key when asked. It's stored in your OS keychain.
4. Pick a provider for the chat and start asking.

The full guide is in [ONBOARDING.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/vscode-extension/ONBOARDING.md).

## Use your own Azure AI Foundry deployments

Run **Rizo: Connect Azure AI Foundry**, enter your resource endpoint (for example `https://my-resource.openai.azure.com`) and API key, and pick your deployments. Then choose **Azure AI Foundry** when you start a chat. Requests go straight to your Azure resource, and Azure bills you. Deployments need to support tool calling.

## Use your own Amazon Bedrock models

Run **Rizo: Connect Amazon Bedrock**, enter your AWS region and a Bedrock API key (Bedrock console, "API keys"), and pick your models. Newer models such as Claude usually need their cross-region inference profile id (for example `us.anthropic...`). Requests go straight to Bedrock, and AWS bills you. Models need to support tool use. Replies currently appear all at once rather than word by word.

## Use tools from MCP servers

Run **Rizo: Add MCP Server**, name it, and enter the command that starts a local server (for example `npx -y @modelcontextprotocol/server-github`) or the https URL of a remote one. Tokens go under `env` (local) or `headers` (remote) in the `rizo.mcp.servers` user setting:

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

Rizo asks before every MCP tool call and shows the arguments. Results are treated as untrusted and secrets in them are redacted. MCP tools are never used in Plan mode, and only your user settings can add servers. **Rizo: Show MCP Servers** shows status and tools, restarts servers and resets "always allow" choices.

## Edit code in place and autocomplete

Select code, press `Cmd+Alt+K` (`Ctrl+Alt+K`) or right-click and pick **Rizo: Edit Selection**, then say what to change. Rizo rewrites it in place and highlights it; choose **Keep** or **Undo**. With nothing selected, Rizo writes new code at the cursor.

Autocomplete is off by default because every suggestion is a small paid request. Turn it on with **Rizo: Toggle Autocomplete** and pick a fast, cheap model in `rizo.autocomplete.model`. Files that usually hold secrets are never sent.

## Safety

- Runs only in trusted folders. Security settings can't be changed by a workspace.
- Tools stay inside your workspace. Other folders need your explicit permission.
- Files like `.env` and private keys need approval to read and are never searched.
- Commands don't get credential environment variables unless you allow them, and secrets in output are redacted.
- Folders that control automation (`.vscode`, `.git`, `.github` and others) always ask before an edit.

Read the full [security model](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/docs/SECURITY-MODEL.md) and the [settings reference](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/docs/SETTINGS.md).

## Feedback

Report bugs and request features on [GitHub](https://github.com/chaitanyaaggarwal9/rizo-bot/issues). Report security issues privately as described in [SECURITY.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/SECURITY.md).

## License

Apache License 2.0 with the Commons Clause: free to use, including at work, and to modify and share, but not to sell. See [LICENSE](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/LICENSE).
