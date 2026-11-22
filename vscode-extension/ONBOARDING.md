# Rizo: Getting started

Rizo is an AI coding assistant for VS Code that uses your own key. You pay your AI provider directly for what you use, and Rizo never sees or stores your key outside your OS keychain.

## 1. Install

Search **Rizo** in the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`) and install it, or use the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=ChaitanyaAggarwal.rizo).

To install a test build (a `.vsix` file), use the `...` menu at the top of the Extensions view and pick **Install from VSIX...**.

## 2. Choose how to pay for models

**OpenRouter (most people).** One key gives you every provider Rizo offers.
1. Sign up at [openrouter.ai](https://openrouter.ai).
2. Add credit, or skip this and use the free models.
3. Create a key under **Settings → Keys**.

**Your own cloud account (optional).** If you already pay for models on Azure or AWS, run **Rizo: Connect Azure AI Foundry** or **Rizo: Connect Amazon Bedrock** and follow the prompts. Those chats are billed by your cloud provider.

## 3. First chat

1. Open a project folder and trust it when VS Code asks. Rizo doesn't run in Restricted Mode.
2. Run **Rizo: Open Chat** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
3. Paste your OpenRouter key when asked.
4. Pick a provider for this chat: Claude, OpenAI, Gemini, Grok, DeepSeek, Qwen, Kimi, Mistral, Z.ai GLM, Free, or a connected Azure or Bedrock account.

## 4. Everyday use

- **Chats.** The dropdown at the top holds your chats. Each keeps its own history and provider. **New** starts one; chats name themselves from your first message. A deleted chat can be restored with **Undo** or **Rizo: Reopen Closed Session**.
- **Models.** The model pill switches between the chat's fast, everyday and strongest models. **More models** lists everything that company offers on OpenRouter, with prices. To use a different company, start a new chat.
- **Effort.** The second pill (Low, Medium, High) sets how hard the model thinks, for models that support it.
- **Act and Plan.** In **Act** mode Rizo can edit files and run commands. In **Plan** mode it only reads, then proposes a plan; **Run this plan** switches back to Act and carries it out.
- **Approvals.** Before a file changes you see a diff, and before a command runs you're asked. **Always Allow (this project)** skips routine prompts, but destructive commands and edits to sensitive folders (`.vscode`, `.git`, `.github` and others) always ask.
- **Undo.** A reply that changed files shows **Undo changes**, which restores them. Commands it ran (installs, git) can't be undone.
- **Stop.** Press Stop at any time. Replies have no length or step limit unless you set one in `rizo.limits.*`.
- **Other folders.** Rizo works inside your workspace folders. To use another folder, add it to the workspace or name its path in your message and approve the prompt. Review access with **Rizo: Manage Folder Access**.
- **Attachments.** Attach files, mention a workspace file, or paste an image for models that support images.
- **Cost.** Each reply shows its tokens, the line under the composer shows the chat's total, and the top of the panel shows today's tokens and this month's cost.

## 5. In the editor

- **Inline edit:** select code, press `Cmd+Alt+K` (`Ctrl+Alt+K`), and describe the change. Choose **Keep** or **Undo**.
- **Autocomplete:** run **Rizo: Toggle Autocomplete** to turn on suggestions as you type. Each suggestion is a small paid request.
- **TODO comments:** click **Implement with Rizo** above a TODO or FIXME.

## 6. Make it yours

- **Project rules:** add `.rizo/instructions.md` to your project with conventions Rizo should follow. Rizo asks you to approve it, and asks again whenever it changes.
- **Slash commands:** `/commit` reviews and commits your changes (asking before anything risky), `/review` reviews the current diff, `/test` writes tests for what you're working on.
- **MCP tools:** run **Rizo: Add MCP Server** to connect GitHub, a database, your docs or other MCP servers.
- **Settings:** everything is listed in the [settings reference](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/docs/SETTINGS.md).

## 7. Help

Open an issue on [GitHub](https://github.com/chaitanyaaggarwal9/rizo-bot/issues) with the bug report or feature request template. Report security problems privately as described in [SECURITY.md](https://github.com/chaitanyaaggarwal9/rizo-bot/blob/main/SECURITY.md).
