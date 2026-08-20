# Rizo — Getting Started

Rizo is an AI coding assistant for VS Code — chat, file edits, and terminal/git commands, with cost-optimized, company-locked model selection. It's BYOK (bring your own key): you use your own OpenRouter API key, so you're only ever billed for what you actually use, directly by OpenRouter.

## 1. Install

Search **"Rizo"** in the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`) and install it, or from the [Marketplace listing](https://marketplace.visualstudio.com/) directly.

Installing from a `.vsix` file instead (e.g. a pre-release build)? `...` menu at the top of the Extensions view → **Install from VSIX...**

## 2. Get an OpenRouter API key

Rizo routes every request through [OpenRouter](https://openrouter.ai), which gives you access to many providers' models behind a single key.

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Add credit (or use the free-tier models — see below, no credit needed)
3. Create a key under **Settings → Keys**

## 3. First run

1. Open any project folder in VS Code
2. `Cmd+Shift+P` / `Ctrl+Shift+P` → run **"Rizo: Open Chat"**
3. Send any message — you'll be prompted once for your API key. Paste it in. It's stored securely in VS Code's own credential storage (your OS keychain), never written to a file or sent anywhere but OpenRouter.
4. Pick a provider for this chat — Claude, Gemini, OpenAI, DeepSeek, Kimi, or Free. It starts you on that company's cheapest variant.

## 4. Using it

- **Threads** — the dropdown at the top holds separate conversations, each with its own history and its own locked-in provider. **New** starts one, **Rename** relabels the current one, **Delete** removes one for good (asks for confirmation first — no undo). They auto-name themselves from your first message.
- **Provider, once per chat** — whichever company you picked at the start is locked in for that chat's whole life. The pill above the messages shows it (e.g. "Claude · Sonnet 5") and opens a dropdown of that same company's other variants only — never a different provider. Want a different company? Start a new chat.
- **Effort** — the second pill next to it (Low / Medium / High) controls how hard the current model thinks, independent of which model's answering. Switch it any time, mid-conversation, with no restart.
- **File edits & commands** — when Rizo wants to edit a file or run a terminal command, you'll get a diff/approval prompt first. **Nothing happens without your approval.** For routine commands you trust, "Always Allow (this project)" stops asking for the rest of that workspace — except commands that look destructive (force-push, hard reset, branch deletion, `rm -rf`), which always ask, every time, on purpose.
- **Working outside the open folder** — file edits stay scoped to what's actually open in VS Code, on purpose. Add another folder via **File → Add Folder to Workspace...** and it's usable too, or just name a real absolute path in your own message ("read the code in /path/to/other-project") — mentioning it once grants access for the rest of that chat.
- **Cost visibility** — the line under the message box shows running tokens + estimated $ cost for the current chat; the top-left corner shows a running today's-tokens / this-month's-cost total across every chat and provider, resetting itself automatically. All billed to you directly by OpenRouter.

## 5. Questions / issues

Open an issue on [GitHub](https://github.com/chaitanyaaggarwal9/rizo-bot/issues) — use the bug report or feature request template.
