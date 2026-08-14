# Rizo — Team Setup

Rizo is our internal AI coding assistant for VS Code — chat, file edits, and terminal/git commands, with cost-optimized model routing. This is proprietary internal software — please don't share the `.vsix` file or this repo outside the team.

## 1. Install

You'll be given a file named something like `rizo-0.0.1.vsix`. In VS Code:

1. Open the **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`)
2. Click the **`...`** menu at the top of that panel → **Install from VSIX...**
3. Select the `.vsix` file you were given

## 2. Get your OpenRouter API key

You'll be given your own personal OpenRouter API key by whoever set up the team account — this key has its own spend limit, separate from everyone else's. Keep it private; don't share it or commit it anywhere.

## 3. First run

1. Open any project folder in VS Code
2. `Cmd+Shift+P` / `Ctrl+Shift+P` → run **"Rizo: Open Chat"**
3. Send any message — you'll be prompted once for your API key. Paste it in. It's stored securely in VS Code's own credential storage, never written to a file.

## 4. Using it

- **Threads** — the dropdown at the top holds separate conversations, each with its own history. **New** starts one, **Rename** relabels the current one. They auto-name themselves from your first message.
- **Free / Paid** — the pill above the messages switches between free-tier models (no cost, lower quality) and cost-optimized paid routing (small model for easy questions, mid-tier for general reasoning, Claude Sonnet 5 for coding). Paid is the default.
- **File edits & commands** — when Rizo wants to edit a file or run a terminal command, you'll get a diff/approval prompt first. **Nothing happens without your approval.** For routine commands you trust, "Always Allow (this project)" stops asking for the rest of that workspace — except commands that look destructive (force-push, hard reset, branch deletion, `rm -rf`), which always ask, every time, on purpose.
- **Cost visibility** — the line under the message box shows running tokens + estimated cost for the current chat.

## 5. Questions / issues

Ping Chaitanya.
