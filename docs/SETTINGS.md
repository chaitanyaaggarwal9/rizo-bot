# Settings and commands

Open settings with `Cmd+,` (`Ctrl+,`) and search for "Rizo". Settings
marked **user only** can't be set by a workspace, so a repository you
open can't change them.

## Permissions

| Setting | Default | Description |
|---|---|---|
| `rizo.permissions.autoApproveCommandPatterns` (user only) | `[]` | Regular expressions for commands that may run without asking. Each must match the **whole** command: `npm test` approves exactly `npm test`, `npm test( .*)?` also allows arguments. Commands that chain, pipe, substitute or redirect always ask, and destructive commands always ask. |
| `rizo.permissions.disabledTools` | `[]` | Tools that are never offered to the model, for example `["run_command"]`. |
| `rizo.permissions.passEnvironmentVariables` (user only) | `[]` | Commands and local MCP servers get your environment minus variables that usually hold credentials (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, prefixes such as `AWS_`, `AZURE_`, `GH_`). List names here to pass them anyway, for example `AWS_PROFILE`. |

## Limits

| Setting | Default | Description |
|---|---|---|
| `rizo.limits.maxStepsPerTurn` | `0` | Most tool-call steps one reply may take before Rizo pauses and asks you to say *continue*. `0` means no limit: a reply runs until the model is done or you press **Stop**. |
| `rizo.limits.maxOutputTokens` | `0` | Most tokens one model response may use. `0` means each model's own maximum. If your OpenRouter credit can't cover that, Rizo asks for what it can afford. |

## Editor features

| Setting | Default | Description |
|---|---|---|
| `rizo.inlineEdit.model` (user only) | `anthropic/claude-sonnet-5.5` | OpenRouter model for **Rizo: Edit Selection**. |
| `rizo.autocomplete.enabled` (user only) | `false` | Show suggestions as you type (`Tab` accepts). Each suggestion is a small paid request. |
| `rizo.autocomplete.model` (user only) | `google/gemini-3.5-flash-lite` | OpenRouter model for autocomplete. A fast, cheap model works best. |
| `rizo.todoCodeLens.enabled` | `true` | Show "Implement with Rizo" above TODO and FIXME comments. |

## MCP servers

`rizo.mcp.servers` (user only) maps a server name to its config. Names
use letters, digits, `-` and single `_` (at most 32 characters).

```json
"rizo.mcp.servers": {
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }
  },
  "docs": {
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer ..." }
  },
  "paused": { "command": "my-server", "disabled": true }
}
```

| Field | For | Meaning |
|---|---|---|
| `command`, `args` | Local | The program to start (no shell) and its arguments |
| `env` | Local | Extra environment variables, such as the server's token |
| `cwd` | Local | Working folder (default: the first workspace folder) |
| `url` | Remote | Streamable HTTP endpoint, https only (http only to localhost) |
| `headers` | Remote | Extra request headers, such as `Authorization` |
| `disabled` | Both | `true` keeps the entry but doesn't start it |

## Chat view

| Setting | Default | Description |
|---|---|---|
| `rizo.composer.sendKey` | `enter` | `enter` sends (Shift+Enter for a new line), or `ctrlEnter` sends with Ctrl/Cmd+Enter. |
| `rizo.view.focusMode` | `false` | Hide tool activity and show only your prompts and the final answers. |

## Commands

Run these from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).

| Command | What it does |
|---|---|
| Rizo: Open Chat | Opens the chat panel |
| Rizo: Change OpenRouter API Key | Replaces the stored key |
| Rizo: Edit Selection (`Cmd+Alt+K` / `Ctrl+Alt+K`) | Rewrites the selection, or writes code at the cursor |
| Rizo: Toggle Autocomplete | Turns suggestions on or off |
| Rizo: Connect / Disconnect Azure AI Foundry | Adds or removes your Azure endpoint, key and deployments |
| Rizo: Connect / Disconnect Amazon Bedrock | Adds or removes your Bedrock region, API key and models |
| Rizo: Add MCP Server | Guided setup that writes `rizo.mcp.servers` |
| Rizo: Show MCP Servers | Status and tools of each server, restart, reset "always allow" choices |
| Rizo: Manage Folder Access | Reviews and revokes folders outside the workspace that chats may use |
| Rizo: Reopen Closed Session | Restores the most recently deleted chat |
| Add File to Rizo Thread | Explorer and editor tab menu: attaches the file to the chat |
| Implement with Rizo | CodeLens on TODO and FIXME comments |
