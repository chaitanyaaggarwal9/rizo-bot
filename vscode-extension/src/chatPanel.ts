// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { callOpenRouter, callWithFallback, CallOptions, ChatMessage, ContentPart, Usage } from './openrouter';
import { modelForMessage, MODEL_FOR_TASK, TaskType, visionModelForTask } from './modelRouter';
import { freeChainForTaskType } from './freeModels';
import { loadSkillsContent } from './skillsLoader';
import { ToolDefinition, TOOLS, executeTool, summarizeToolCall, summarizeToolResult } from './tools';
import { expandSlashCommand } from './slashCommands';
import { loadProjectInstructions } from './projectInstructions';
import {
  StoredMessage,
  DEFAULT_THREAD_NAME,
  listThreads,
  createThread,
  loadThread,
  saveThreadMessages,
  renameThread,
  deriveThreadName,
  updateThreadSummary,
  sumThreadTokens,
  sumThreadCost,
} from './threadStore';

const MAX_TOOL_ITERATIONS = 8;

const SECRET_KEY = 'rizo.openRouterApiKey';
const FREE_MODE_KEY = 'rizo.freeMode';

// Long threads stop replaying their full raw history once they pass this
// many stored messages — everything older than the last SUMMARY_KEEP_TAIL
// gets folded into a running summary instead (see maybeSummarize below).
const SUMMARIZE_THRESHOLD = 20;
const SUMMARY_KEEP_TAIL = 10;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB — generous for a screenshot, not for a video

interface IncomingAttachment {
  name: string;
  type: 'text' | 'image';
  content: string; // utf-8 text, or base64 for images
  mimeType?: string;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private activeThreadId: string;
  // Set for the duration of one in-flight handleSend call; 'cancel' from the
  // webview aborts the fetch/stream via the controller and records the
  // turnId so the tool loop (which can't be interrupted mid-iteration) at
  // least refuses to start the *next* one.
  private activeAbortController: AbortController | undefined;
  private cancelledTurnId: string | undefined;

  public static createOrShow(context: vscode.ExtensionContext) {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'rizoChat',
      'Rizo',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    // Without this the tab just shows plain text — every other AI chat
    // panel shows its own icon here instead.
    panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'icon.png'));

    ChatPanel.currentPanel = new ChatPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    // Pick up the most recently updated thread, or create one if this is
    // the first time the panel has ever been opened.
    const threads = listThreads(context);
    this.activeThreadId = threads.length > 0 ? threads[0].id : createThread(context).id;

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'ready':
            this.sendInit();
            break;
          case 'send':
            await this.handleSend(message.text, message.turnId, message.attachments || []);
            break;
          case 'cancel':
            this.activeAbortController?.abort();
            this.cancelledTurnId = message.turnId;
            break;
          case 'attachFile':
            await this.handleAttachFile();
            break;
          case 'attachWorkspaceFile':
            await this.handleAttachWorkspaceFile();
            break;
          case 'newThread':
            this.activeThreadId = createThread(this.context).id;
            this.sendInit();
            break;
          case 'switchThread':
            this.activeThreadId = message.id;
            this.sendInit();
            break;
          case 'renameThread':
            await this.handleRename();
            break;
          case 'setFreeMode':
            await this.context.workspaceState.update(FREE_MODE_KEY, !!message.value);
            this.sendInit();
            break;
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private isFreeMode(): boolean {
    return this.context.workspaceState.get<boolean>(FREE_MODE_KEY, false);
  }

  private sendInit() {
    const thread = loadThread(this.context, this.activeThreadId);
    const messages = thread?.messages || [];
    this.panel.webview.postMessage({
      type: 'init',
      threads: listThreads(this.context),
      activeThreadId: this.activeThreadId,
      messages,
      freeMode: this.isFreeMode(),
      threadTokens: sumThreadTokens(messages),
      threadCost: sumThreadCost(messages),
    });
  }

  private async handleRename() {
    const thread = loadThread(this.context, this.activeThreadId);
    const name = await vscode.window.showInputBox({
      prompt: 'Rename this chat',
      value: thread?.name || '',
      ignoreFocusOut: true,
    });
    if (name && name.trim()) {
      renameThread(this.context, this.activeThreadId, name.trim());
      this.sendInit();
    }
  }

  private async getApiKey(): Promise<string | undefined> {
    let key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      key = await vscode.window.showInputBox({
        prompt: 'Enter your OpenRouter API key (get one at openrouter.ai/keys)',
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        key = key.trim();
        await this.context.secrets.store(SECRET_KEY, key);
      }
    } else {
      key = key.trim();
    }
    return key;
  }

  // Picks the paid single-model path or the free fallback-chain path,
  // depending on the workspace's free/paid toggle. Free mode never touches
  // a paid model, even for coding — that's the entire point of the toggle.
  // hasImage bumps the paid path to a vision-capable model (see
  // visionModelForTask); the free chain has no vision models in it at all
  // today, so an image in free mode fails clearly instead of silently
  // getting ignored by a model that can't see it.
  private async callModel(
    apiKey: string,
    taskType: TaskType,
    messages: ChatMessage[],
    hasImage: boolean,
    tools: ToolDefinition[],
    options: CallOptions = {},
  ) {
    if (this.isFreeMode()) {
      if (hasImage) {
        throw new Error(
          "Image attachments need a vision-capable model, and the free tier doesn't currently include one. Switch to Paid mode to use an image in this chat.",
        );
      }
      return callWithFallback(apiKey, freeChainForTaskType(taskType), messages, tools, options);
    }
    const model = hasImage ? visionModelForTask(taskType) : MODEL_FOR_TASK[taskType];
    return callOpenRouter(apiKey, model, messages, tools, options);
  }

  // "Attach file...": any file on disk, not limited to the workspace — an
  // explicit user-driven pick through the OS file dialog, so it's exempt
  // from resolveSafePath's workspace-boundary check on purpose (that check
  // guards against the *model* reaching outside the workspace on its own,
  // not against the human deliberately choosing a file to hand it).
  private async handleAttachFile() {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach' });
    if (!picked || picked.length === 0) return;
    await this.readAndSendAttachment(picked[0].fsPath);
  }

  // "Mention file from this project...": a quick pick over workspace files,
  // read immediately (same as Attach) rather than inserted as a reference
  // for the model to read later via read_file — attaching should mean "use
  // this content now," not "maybe go look at this."
  private async handleAttachWorkspaceFile() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('No workspace folder is open.');
      return;
    }
    const files = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}',
      500,
    );
    const items = files.map((uri) => ({
      label: path.basename(uri.fsPath),
      description: path.relative(folder.uri.fsPath, uri.fsPath),
      uri,
    }));
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Mention a file from this project' });
    if (!choice) return;
    await this.readAndSendAttachment(choice.uri.fsPath);
  }

  private async readAndSendAttachment(fsPath: string) {
    try {
      const stat = fs.statSync(fsPath);
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        vscode.window.showWarningMessage(
          `${path.basename(fsPath)} is over the 5MB attachment limit — pick a smaller file.`,
        );
        return;
      }

      const ext = path.extname(fsPath).toLowerCase();
      const name = path.basename(fsPath);

      if (IMAGE_EXTENSIONS.has(ext)) {
        const buf = fs.readFileSync(fsPath);
        const mimeType = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
        const attachment: IncomingAttachment = { name, type: 'image', content: buf.toString('base64'), mimeType };
        this.panel.webview.postMessage({ type: 'attachmentAdded', attachment });
        return;
      }

      // Text path: read as utf-8 and reject anything that doesn't look like
      // text (a stray binary picked by mistake), rather than dumping
      // garbled bytes into the conversation. A null byte in the first
      // slice is the standard cheap tell for 'this isn't text' (the same
      // heuristic git itself uses).
      const buf = fs.readFileSync(fsPath);
      if (buf.subarray(0, 8000).includes(0)) {
        vscode.window.showWarningMessage(`${name} looks like a binary file Rizo can't read as text.`);
        return;
      }
      const text = buf.toString('utf-8');
      const attachment: IncomingAttachment = { name, type: 'text', content: text };
      this.panel.webview.postMessage({ type: 'attachmentAdded', attachment });
    } catch (err: any) {
      vscode.window.showWarningMessage(`Couldn't attach ${path.basename(fsPath)}: ${err.message}`);
    }
  }

  // Flattens stored/API message content down to plain text, for the
  // summarizer prompt — an attached image becomes a plain marker since the
  // summary itself never needs to carry the image data forward.
  private static contentToPlainText(content: string | ContentPart[] | null | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    return content
      .map((part) => (part.type === 'text' ? part.text : '[image attached]'))
      .join(' ')
      .trim();
  }

  // Once a thread passes SUMMARIZE_THRESHOLD stored messages, folds
  // everything older than the last SUMMARY_KEEP_TAIL into a running summary
  // via a single cheap-tier call, so future turns replay that summary
  // instead of the full raw history — the point is token cost, not context
  // quality, so this only touches what gets *sent* to the model; every
  // message is still stored and still shown in full in the UI. Runs after
  // the reply is already back with the user (fire-and-forget from
  // handleSend) so this housekeeping never adds to reply latency, and a
  // failure here just means "try again next turn," not a broken chat.
  private async maybeSummarize(apiKey: string) {
    const thread = loadThread(this.context, this.activeThreadId);
    if (!thread) return;

    const already = thread.summarizedCount || 0;
    const total = thread.messages.length;
    if (total - already < SUMMARIZE_THRESHOLD) return;

    const foldEnd = total - SUMMARY_KEEP_TAIL;
    const toFold = thread.messages.slice(already, foldEnd);
    if (toFold.length === 0) return;

    const transcript = toFold
      .map((m) => `${m.role}: ${ChatPanel.contentToPlainText(m.content)}`)
      .join('\n\n');
    const priorSummary = thread.summary ? `Existing summary so far:\n${thread.summary}\n\n` : '';

    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Summarize this conversation excerpt concisely for use as background context in a follow-up request. Preserve concrete facts, decisions, file names, and code details that matter; drop pleasantries. A short paragraph, not a list.',
      },
      { role: 'user', content: `${priorSummary}New turns to fold in:\n\n${transcript}` },
    ];

    try {
      const { message } = await callOpenRouter(apiKey, MODEL_FOR_TASK.low, prompt);
      const newSummary = (message.content as string) || thread.summary || '';
      if (newSummary) updateThreadSummary(this.context, this.activeThreadId, newSummary, foldEnd);
    } catch {
      // Best-effort — the thread just keeps replaying full history until
      // this succeeds on a later turn.
    }
  }

  private async handleSend(text: string, turnId: string, attachments: IncomingAttachment[] = []) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.panel.webview.postMessage({ type: 'error', error: 'No API key provided.', turnId });
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      // /commit, /review, /test expand to a canned prompt before anything
      // else runs — forced onto the coding tier regardless of keyword
      // match, since typing the command IS the signal. An unrecognized
      // "/foo" isn't an error, it just falls through as literal text.
      const slashExpansion = expandSlashCommand(text);
      const effectiveText = slashExpansion ?? text;
      const { taskType } = slashExpansion
        ? { taskType: 'coding' as TaskType }
        : modelForMessage(effectiveText);

      // Only coding-tier messages get skill instructions loaded — general
      // low/medium chat doesn't need engineering-discipline guidance.
      const skillsDir = path.join(this.context.extensionPath, 'skills');
      const skillsContent = loadSkillsContent(skillsDir, effectiveText, taskType);

      // Without any system prompt, some models (DeepSeek in particular)
      // default to Chinese on short/ambiguous input — this instruction
      // always applies, regardless of task type.
      const systemParts = [
        'Always respond in English, even if the user writes in another language or the request is ambiguous.',
      ];
      if (skillsContent) systemParts.push(skillsContent);

      // The user's own per-project rules (.rizo/instructions.md), if any —
      // unlike skills, not gated to taskType 'coding': this is user-authored
      // project intent that plausibly matters for non-coding replies too.
      // Zero-cost, silently absent, when the file doesn't exist.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const projectInstructions = loadProjectInstructions(workspaceRoot);
      if (projectInstructions) {
        systemParts.push(
          `Project-specific instructions (from .rizo/instructions.md in this workspace):\n${projectInstructions}`,
        );
      }

      const thread = loadThread(this.context, this.activeThreadId);

      // Once this thread has been folded by maybeSummarize, only replay the
      // summary plus whatever's newer than what got folded — not the full
      // raw history. Every message is still stored and still shown in the
      // UI in full; this only shrinks what gets sent to the model.
      if (thread?.summary) {
        systemParts.push(`Summary of earlier parts of this conversation (for background context, don't repeat it back):\n${thread.summary}`);
      }
      const summarizedCount = thread?.summarizedCount || 0;
      const tailMessages = (thread?.messages || []).slice(summarizedCount);
      const history: ChatMessage[] = tailMessages.map((m) => ({ role: m.role, content: m.content }));

      // Text attachments fold into the message text itself (no "file" part
      // type in the OpenAI-compatible schema); images become separate
      // image_url parts. Plain string content when there's nothing to
      // attach, so the common case doesn't pay for the array wrapper.
      let userContent: string | ContentPart[] = effectiveText;
      if (attachments.length > 0) {
        let combinedText = effectiveText;
        const imageParts: ContentPart[] = [];
        for (const att of attachments) {
          if (att.type === 'image') {
            imageParts.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.content}` } });
          } else {
            combinedText += `\n\n--- Attached: ${att.name} ---\n${att.content}`;
          }
        }
        userContent = [{ type: 'text', text: combinedText }, ...imageParts];
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: systemParts.join('\n\n---\n\n') },
        ...history,
        { role: 'user', content: userContent },
      ];

      // Vision is needed if this turn attached an image, or if replayed
      // history carries one from earlier in the thread (a follow-up like
      // "what's wrong with it" needs the model to still see the image).
      const hasImage = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
      );

      // rizo.permissions.disabledTools — filtered out here so the model is
      // never even offered a disabled tool (no wasted round-trip);
      // executeTool has its own check as a backstop.
      const disabledTools = vscode.workspace.getConfiguration('rizo').get<string[]>('permissions.disabledTools', []);
      const enabledTools = TOOLS.filter((t) => !disabledTools.includes(t.function.name));

      let answeredBy = '';
      let finalReply = '(no final response — hit the tool-call iteration limit)';
      const totalUsage = emptyUsage();

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (this.cancelledTurnId === turnId) break;

        const { model: usedModel, message, usage } = await this.callModel(apiKey, taskType, messages, hasImage, enabledTools, {
          signal: controller.signal,
          onDelta: (chunk) => this.panel.webview.postMessage({ type: 'textDelta', turnId, text: chunk }),
          // A model failed after already streaming some text — the webview
          // needs to clear that partial text before the next model's fresh
          // attempt starts, so the two don't visually run together.
          onRestart: () => this.panel.webview.postMessage({ type: 'textReset', turnId }),
        });
        answeredBy = usedModel;
        totalUsage.promptTokens += usage.promptTokens;
        totalUsage.completionTokens += usage.completionTokens;
        totalUsage.totalTokens += usage.totalTokens;

        if (!message.tool_calls || message.tool_calls.length === 0) {
          finalReply = message.content || '';
          break;
        }

        // Record the assistant's tool-call turn before executing anything,
        // so history stays valid even if a tool call throws.
        messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls });

        // Tool activity is visible in the transcript as it happens — a
        // start line the moment a call is issued, updated once it resolves.
        // Cancellation only stops the *next* call/iteration from starting;
        // a call already in flight here still runs to completion (see
        // Stop/Cancel's design notes — killing a running command is a
        // separate, deferred change).
        for (const toolCall of message.tool_calls) {
          if (this.cancelledTurnId === turnId) break;
          this.panel.webview.postMessage({
            type: 'toolStart',
            turnId,
            callId: toolCall.id,
            name: toolCall.function.name,
            argsSummary: summarizeToolCall(toolCall.function.name, toolCall.function.arguments),
          });
          const result = await executeTool(this.context, toolCall.function.name, toolCall.function.arguments);
          this.panel.webview.postMessage({
            type: 'toolEnd',
            turnId,
            callId: toolCall.id,
            ok: !result.startsWith('Error:'),
            resultSummary: summarizeToolResult(result),
          });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        }
      }

      const elapsedMs = Date.now() - startedAt;

      // Persist only the final exchange — not the tool-call sub-steps.
      const updated: StoredMessage[] = [
        ...(thread?.messages || []),
        { role: 'user', content: userContent },
        {
          role: 'assistant',
          content: finalReply,
          model: answeredBy,
          taskType,
          promptTokens: totalUsage.promptTokens,
          completionTokens: totalUsage.completionTokens,
          totalTokens: totalUsage.totalTokens,
        },
      ];
      saveThreadMessages(this.context, this.activeThreadId, updated);

      // Auto-name the thread from its first message, same as most chat
      // apps — only when it's still the default name, never overriding a
      // name you set yourself via Rename.
      if ((thread?.messages.length ?? 0) === 0 && thread?.name === DEFAULT_THREAD_NAME) {
        renameThread(this.context, this.activeThreadId, deriveThreadName(effectiveText));
        this.panel.webview.postMessage({
          type: 'threadListUpdated',
          threads: listThreads(this.context),
          activeThreadId: this.activeThreadId,
        });
      }

      this.panel.webview.postMessage({
        type: 'reply',
        turnId,
        model: answeredBy,
        taskType,
        reply: finalReply,
        usage: totalUsage,
        elapsedMs,
        threadTokens: sumThreadTokens(updated),
        threadCost: sumThreadCost(updated),
      });

      // Fire-and-forget: never makes the user wait on housekeeping. See
      // maybeSummarize's own comment for what this actually does.
      void this.maybeSummarize(apiKey);
    } catch (err: any) {
      // Stop was clicked — the webview already showed "Stopped." locally
      // (see send()'s cancel handling), this just confirms the extension
      // side actually unwound rather than silently continuing.
      if (err.name === 'AbortError') {
        this.panel.webview.postMessage({ type: 'cancelled', turnId });
      } else if (/user not found|401|unauthorized/i.test(err.message)) {
        // "User not found" / 401 means OpenRouter didn't recognize the key
        // at all — clear it so the next send re-prompts instead of failing
        // forever on a bad stored key.
        await this.context.secrets.delete(SECRET_KEY);
        this.panel.webview.postMessage({
          type: 'error',
          turnId,
          error: `${err.message} — cleared the stored key. Send your message again to re-enter it.`,
        });
      } else {
        this.panel.webview.postMessage({ type: 'error', turnId, error: err.message });
      }
    } finally {
      // Only clear if this turn still owns the controller — a rapid
      // second send() before this one's finally runs would otherwise wipe
      // out the newer turn's own controller.
      if (this.activeAbortController === controller) this.activeAbortController = undefined;
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    const iconPath = path.join(this.context.extensionPath, 'icon.png');
    const iconDataUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
    const mascotPath = path.join(this.context.extensionPath, 'assets', 'mascot.png');
    const mascotDataUri = `data:image/png;base64,${fs.readFileSync(mascotPath).toString('base64')}`;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    margin: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-size: 13px;
  }

  /* --- Header / thread bar --- */
  #threadBar {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
    align-items: center;
  }
  #threadSelect {
    flex: 1;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
  }
  .iconBtn {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .iconBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }

  /* Free/Paid segmented control — both options always visible, active one
     highlighted, sits directly above the message area so the current
     spending mode is never ambiguous. Brand teal for Paid (the routed,
     cost-optimized path), amber for Free — same pairing as rizobot.com,
     no emoji standing in for what the label text already says. */
  #modeBar {
    display: flex;
    justify-content: center;
    padding: 8px 12px 0;
  }
  #modeSwitch {
    display: flex;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 999px;
    padding: 2px;
    gap: 2px;
  }
  .modeOption {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: none;
    border-radius: 999px;
    padding: 5px 16px;
    font-size: 11.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .modeOption:hover:not(.active) { color: var(--vscode-foreground); }
  .modeOption.active { font-weight: 600; }
  .modeOption[data-mode="free"].active { background: rgba(223, 160, 92, 0.16); color: #DFA05C; }
  .modeOption[data-mode="paid"].active { background: rgba(76, 163, 158, 0.18); color: #4CA39E; }

  /* --- Empty state --- */
  #emptyState {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    text-align: center;
  }
  #emptyState img {
    width: 130px;
    height: auto;
    filter: drop-shadow(0 0 32px rgba(76, 163, 158, 0.3));
  }
  #emptyState .hint {
    font-size: 12.5px;
    color: var(--vscode-descriptionForeground);
    max-width: 340px;
    line-height: 1.5;
  }
  #emptyState .hint strong { color: var(--vscode-foreground); font-weight: 500; }

  /* --- Messages --- */
  #messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
  .msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-bottom-left-radius: 4px; }
  .msg .attachedImg { max-width: 220px; max-height: 220px; border-radius: 8px; display: block; margin-top: 6px; }

  /* --- Live tool-call transcript --- */
  .transcript { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .transcriptLine {
    font-size: 11.5px;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(128,128,128,0.08);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .transcriptLine.running { opacity: 0.75; }
  .transcriptLine.running::after { content: ' …'; }
  .transcriptLine.failed { color: var(--vscode-errorForeground, #f14c4c); }
  .streamedText { display: block; }
  .stoppedNote { font-size: 11px; opacity: 0.6; font-style: italic; margin-top: 6px; }

  /* --- Markdown rendering (assistant replies only) --- */
  .msg pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 8px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 6px 0; }
  .msg code { font-family: var(--vscode-editor-font-family); background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 4px; }
  .msg pre code { background: none; padding: 0; }
  .msg ul { margin: 4px 0; padding-left: 20px; }
  .msg li { margin: 2px 0; }
  .mdHeading { font-weight: 600; font-size: 1.08em; }

  .model-tag {
    display: inline-block;
    font-size: 10px;
    opacity: 0.65;
    margin-bottom: 6px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.15));
    color: var(--vscode-badge-foreground, inherit);
  }

  /* --- Composer --- */
  #composerWrap { border-top: 1px solid var(--vscode-widget-border); padding: 10px 12px 6px; position: relative; }

  #attachmentChips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.15));
    border-radius: 8px;
    padding: 3px 6px 3px 3px;
    font-size: 11px;
    max-width: 200px;
  }
  .chip img { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
  .chip .chipIcon {
    width: 20px; height: 20px; border-radius: 4px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--vscode-editorWidget-background);
    font-size: 10px;
  }
  .chip .chipName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .chipRemove {
    background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground);
    padding: 0 2px; font-size: 13px; line-height: 1; flex-shrink: 0;
  }
  .chip .chipRemove:hover { color: var(--vscode-errorForeground, #f14c4c); }

  #composer {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 14px;
    padding: 8px 8px 8px 8px;
  }
  #composer:focus-within { border-color: var(--vscode-focusBorder); }

  #attachBtn {
    flex-shrink: 0;
    width: 28px; height: 28px;
    border-radius: 50%;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: none;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 17px;
    line-height: 1;
  }
  #attachBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-foreground); }

  #attachMenu {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 12px;
    margin-bottom: 6px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    z-index: 10;
    min-width: 210px;
  }
  #attachMenu.open { display: block; }
  #attachMenu button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--vscode-dropdown-foreground);
    padding: 7px 10px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
  }
  #attachMenu button:hover { background: var(--vscode-list-hoverBackground); }

  #inputBox {
    flex: 1;
    background: transparent;
    color: var(--vscode-input-foreground);
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 13px;
    resize: none;
    max-height: 160px;
    line-height: 1.4;
    padding: 4px 0;
  }
  #sendBtn {
    flex-shrink: 0;
    width: 30px; height: 30px;
    border-radius: 50%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px;
    line-height: 1;
  }
  #sendBtn:disabled { opacity: 0.5; cursor: default; }
  #sendBtn:not(:disabled):hover { background: var(--vscode-button-hoverBackground); }
  /* While a turn is in flight, sendBtn becomes a Stop button instead of
     being disabled — still clickable, just does something different. */
  #sendBtn.stopping { background: rgba(241, 76, 76, 0.18); color: var(--vscode-errorForeground, #f14c4c); }
  #sendBtn.stopping:hover { background: rgba(241, 76, 76, 0.28); }
  #inputBox:disabled { opacity: 0.6; }

  #statsBar {
    display: flex;
    justify-content: flex-end;
    padding: 6px 6px 4px;
    font-size: 11px;
    opacity: 0.55;
  }
</style>
</head>
<body>
  <div id="threadBar">
    <select id="threadSelect"></select>
    <button class="iconBtn" id="newThreadBtn">New</button>
    <button class="iconBtn" id="renameThreadBtn">Rename</button>
  </div>
  <div id="modeBar">
    <div id="modeSwitch">
      <button class="modeOption" id="freeOption" data-mode="free">Free</button>
      <button class="modeOption" id="paidOption" data-mode="paid">Paid</button>
    </div>
  </div>
  <div id="emptyState">
    <img src="${mascotDataUri}" alt="">
    <div class="hint">Ask a question, or point Rizo at a file or a task.<br>Everything routes to a model sized for the job, <strong>free</strong> or <strong>paid</strong>, your call above.</div>
  </div>
  <div id="messages"></div>
  <div id="composerWrap">
    <div id="attachmentChips"></div>
    <div id="attachMenu">
      <button id="attachFileOption">Attach file&hellip;</button>
      <button id="attachWorkspaceOption">Mention file from this project&hellip;</button>
    </div>
    <div id="composer">
      <button id="attachBtn" title="Attach">+</button>
      <textarea id="inputBox" placeholder="Message... (Enter to send, Shift+Enter for a new line)" rows="1"></textarea>
      <button id="sendBtn" title="Send">➤</button>
    </div>
    <div id="statsBar"><span id="tokenStats"></span></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('inputBox');
    const sendBtn = document.getElementById('sendBtn');
    const threadSelect = document.getElementById('threadSelect');
    const newThreadBtn = document.getElementById('newThreadBtn');
    const renameThreadBtn = document.getElementById('renameThreadBtn');
    const freeOption = document.getElementById('freeOption');
    const paidOption = document.getElementById('paidOption');
    const tokenStats = document.getElementById('tokenStats');
    // The one in-flight turn's live state — transcript lines, streamed
    // text, and the eventual final render are three states of this one
    // object/DOM node, not three competing update paths. null whenever
    // nothing is in flight. Every extension->webview message during a
    // turn carries that turn's id; anything whose id doesn't match
    // activeTurn.id is dropped (see the message listener below) — that's
    // what makes Stop safe without the extension having to guarantee
    // instant termination.
    let activeTurn = null;

    function formatCost(cost) {
      if (!cost) return '$0.00';
      return cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2);
    }

    function formatTag(model, taskType, usage, elapsedMs) {
      const parts = [model];
      if (taskType) parts.push(taskType);
      if (usage && usage.totalTokens) parts.push(usage.totalTokens.toLocaleString() + ' tokens');
      if (typeof elapsedMs === 'number') parts.push((elapsedMs / 1000).toFixed(1) + 's');
      return parts.join('  ·  ');
    }

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Hand-rolled, dependency-free markdown subset — fenced code blocks,
    // inline code, bold/italic, lists, headers (flattened to bold, not
    // real heading tags — a full <h1> in an ~82%-wide chat bubble reads
    // oversized). Deliberately no link/image syntax: that would reopen an
    // injection/tracking vector nobody asked for. Escaping happens FIRST,
    // before any transform runs, and code spans/blocks are protected with
    // a placeholder token so later emphasis regexes never fire inside
    // them — the two things standing between this and an XSS bug in
    // whatever a model decides to output.
    function renderMarkdown(raw) {
      let text = escapeHtml(raw);

      // No backslash-escape sequences anywhere below (no newline, digit,
      // whitespace, or word-char shorthand, no escaped asterisk) — this
      // whole script is embedded inside an outer TypeScript template
      // literal (getHtml()'s return value) back in the extension source,
      // and THAT literal processes backslash escapes in its own pass
      // before this code is ever handed to a JS engine as real source: a
      // literal newline escape in the TS source becomes an actual newline
      // BYTE, not the original two-character escape, silently corrupting
      // literal built that way. Character classes ([*] for a literal
      // asterisk, [0-9] for a digit, [^] for "any character") and a
      // real newline character built via fromCharCode sidestep the whole
      // problem — nothing here needs a backslash to survive that pass.
      const NL = String.fromCharCode(10);
      const TICK = String.fromCharCode(96);
      const FENCE = TICK + TICK + TICK;

      const codeBlocks = [];
      text = text.replace(new RegExp(FENCE + '([A-Za-z0-9_-]*)' + NL + '?([^]*?)' + FENCE, 'g'), (_, _lang, code) => {
        const idx = codeBlocks.length;
        const trimmed = code.charAt(code.length - 1) === NL ? code.slice(0, -1) : code;
        codeBlocks.push('<pre><code>' + trimmed + '</code></pre>');
        return ' CODEBLOCK' + idx + ' ';
      });

      const inlineCodes = [];
      text = text.replace(new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g'), (_, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push('<code>' + code + '</code>');
        return ' INLINECODE' + idx + ' ';
      });

      text = text.replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
      text = text.replace(/[*]([^*]+)[*]/g, '<em>$1</em>');
      text = text.replace(/^#{1,6} +(.+)$/gm, '<span class="mdHeading">$1</span>');

      const lines = text.split(NL);
      const out = [];
      let inList = false;
      for (const line of lines) {
        const m = line.match(/^[-*] +(.+)$/);
        if (m) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push('<li>' + m[1] + '</li>');
        } else {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push(line);
        }
      }
      if (inList) out.push('</ul>');
      text = out.join(NL);

      text = text.replace(/ INLINECODE([0-9]+) /g, (_, i) => inlineCodes[Number(i)]);
      text = text.replace(/ CODEBLOCK([0-9]+) /g, (_, i) => codeBlocks[Number(i)]);
      return text;
    }

    function setSending(isSending) {
      sendBtn.textContent = isSending ? '■' : '➤';
      sendBtn.title = isSending ? 'Stop' : 'Send';
      sendBtn.classList.toggle('stopping', isSending);
      inputEl.disabled = isSending;
    }

    // Builds the one bubble a turn lives in for its whole lifecycle:
    // transcript lines appended as tool calls happen, then streamed text,
    // then (finalizeTurn) the rendered final content — same DOM node
    // throughout, never removed-and-replaced.
    function startTurn(turnId) {
      const el = document.createElement('div');
      el.className = 'msg assistant pending';
      const transcriptEl = document.createElement('div');
      transcriptEl.className = 'transcript';
      const textEl = document.createElement('span');
      textEl.className = 'streamedText';
      textEl.textContent = 'Thinking…';
      el.appendChild(transcriptEl);
      el.appendChild(textEl);
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      activeTurn = { id: turnId, el, transcriptEl, textEl, toolLines: new Map(), textBuffer: '', hasText: false };
      return activeTurn;
    }

    function handleToolStart(turnId, callId, name, argsSummary) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const line = document.createElement('div');
      line.className = 'transcriptLine running';
      line.textContent = argsSummary || name;
      activeTurn.transcriptEl.appendChild(line);
      activeTurn.toolLines.set(callId, line);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleToolEnd(turnId, callId, ok, resultSummary) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const line = activeTurn.toolLines.get(callId);
      if (!line) return;
      line.classList.remove('running');
      if (!ok) line.classList.add('failed');
      line.textContent += (ok ? '  ✓ ' : '  ✗ ') + resultSummary;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleTextDelta(turnId, text) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      if (!activeTurn.hasText) { activeTurn.textBuffer = ''; activeTurn.hasText = true; }
      activeTurn.textBuffer += text;
      activeTurn.textEl.textContent = activeTurn.textBuffer;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // A model failed after already streaming some text — clear it before
    // the next fallback model's fresh attempt starts, so the two don't
    // visually run together as one garbled reply.
    function handleTextReset(turnId) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      activeTurn.textBuffer = '';
      activeTurn.hasText = false;
      activeTurn.textEl.textContent = 'Thinking…';
    }

    // Swaps the streamed plain text over to rendered markdown exactly
    // once, using the server's authoritative final string rather than the
    // client's own concatenated deltas — a dropped/reordered textDelta
    // can't cause drift this way.
    function finalizeTurn(turnId, replyText, model, taskType, usage, elapsedMs) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const turn = activeTurn;
      turn.el.classList.remove('pending');
      if (model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = formatTag(model, taskType, usage, elapsedMs);
        const br = document.createElement('br');
        turn.el.insertBefore(br, turn.el.firstChild);
        turn.el.insertBefore(tag, br);
      }
      turn.textEl.innerHTML = renderMarkdown(replyText || '');
      activeTurn = null;
      setSending(false);
    }

    // content is either a plain string, or an array of parts ({type:'text',
    // text} / {type:'image_url', image_url:{url}}) — the same shape stored
    // messages and outgoing API calls use, so history replay and a
    // just-sent message render identically.
    function addMessage(role, content, model, taskType, usage, elapsedMs) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'assistant' && model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = formatTag(model, taskType, usage, elapsedMs);
        div.appendChild(tag);
        div.appendChild(document.createElement('br'));
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'image_url') {
            const img = document.createElement('img');
            img.className = 'attachedImg';
            img.src = part.image_url.url;
            div.appendChild(img);
          } else if (part.type === 'text' && part.text) {
            // Array content only happens for a user message carrying
            // attachments today — plain text, never markdown-rendered.
            const span = document.createElement('span');
            span.textContent = part.text;
            div.appendChild(span);
          }
        }
      } else if (role === 'assistant') {
        // Markdown applies to assistant replies only — never a user's own
        // pasted text, which shouldn't be reinterpreted as markup.
        const span = document.createElement('span');
        span.innerHTML = renderMarkdown(content || '');
        div.appendChild(span);
      } else {
        const span = document.createElement('span');
        span.textContent = content;
        div.appendChild(span);
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function renderThreadList(threads, activeId) {
      threadSelect.innerHTML = '';
      for (const t of threads) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        if (t.id === activeId) opt.selected = true;
        threadSelect.appendChild(opt);
      }
    }

    const emptyStateEl = document.getElementById('emptyState');

    function renderMessages(messages) {
      // Only called on a context switch (init/new/switch thread), never
      // mid-reply — safe to drop whatever turn belonged to the view being
      // replaced rather than leave the Stop button stuck showing forever.
      activeTurn = null;
      setSending(false);
      messagesEl.innerHTML = '';
      emptyStateEl.style.display = messages.length === 0 ? 'flex' : 'none';
      messagesEl.style.display = messages.length === 0 ? 'none' : 'flex';
      for (const m of messages) {
        addMessage(m.role, m.content, m.model, m.taskType, m.totalTokens ? { totalTokens: m.totalTokens } : null);
      }
    }

    function renderFreeMode(freeMode) {
      freeOption.classList.toggle('active', freeMode);
      paidOption.classList.toggle('active', !freeMode);
    }

    function renderThreadStats(totalTokens, totalCost) {
      if (!totalTokens) { tokenStats.textContent = ''; return; }
      tokenStats.textContent = 'Total this chat: ' + totalTokens.toLocaleString() + ' tokens  ·  ' + formatCost(totalCost);
    }

    function autoGrow() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    }
    inputEl.addEventListener('input', autoGrow);

    // --- Attachments ---
    const attachBtn = document.getElementById('attachBtn');
    const attachMenu = document.getElementById('attachMenu');
    const attachFileOption = document.getElementById('attachFileOption');
    const attachWorkspaceOption = document.getElementById('attachWorkspaceOption');
    const attachmentChipsEl = document.getElementById('attachmentChips');
    let pendingAttachments = [];

    function renderChips() {
      attachmentChipsEl.innerHTML = '';
      pendingAttachments.forEach((att, i) => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        if (att.type === 'image') {
          const img = document.createElement('img');
          img.src = 'data:' + att.mimeType + ';base64,' + att.content;
          chip.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.className = 'chipIcon';
          icon.textContent = '▤';
          chip.appendChild(icon);
        }
        const name = document.createElement('span');
        name.className = 'chipName';
        name.textContent = att.name;
        name.title = att.name;
        chip.appendChild(name);
        const remove = document.createElement('button');
        remove.className = 'chipRemove';
        remove.textContent = '×';
        remove.title = 'Remove';
        remove.addEventListener('click', () => {
          pendingAttachments.splice(i, 1);
          renderChips();
        });
        chip.appendChild(remove);
        attachmentChipsEl.appendChild(chip);
      });
    }

    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => attachMenu.classList.remove('open'));
    attachFileOption.addEventListener('click', () => {
      attachMenu.classList.remove('open');
      vscode.postMessage({ type: 'attachFile' });
    });
    attachWorkspaceOption.addEventListener('click', () => {
      attachMenu.classList.remove('open');
      vscode.postMessage({ type: 'attachWorkspaceFile' });
    });

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      emptyStateEl.style.display = 'none';
      messagesEl.style.display = 'flex';

      const displayContent = pendingAttachments.length
        ? [{ type: 'text', text }, ...pendingAttachments.filter((a) => a.type === 'image').map((a) => ({
            type: 'image_url', image_url: { url: 'data:' + a.mimeType + ';base64,' + a.content },
          }))]
        : text;
      addMessage('user', displayContent);

      const attachments = pendingAttachments;
      pendingAttachments = [];
      renderChips();
      inputEl.value = '';
      autoGrow();

      const turnId = Date.now() + '-' + Math.random().toString(36).slice(2);
      startTurn(turnId);
      setSending(true);
      vscode.postMessage({ type: 'send', text, attachments, turnId });
    }

    // sendBtn does double duty: Send when idle, Stop while a turn is in
    // flight (see setSending). Stop finalizes the UI immediately rather
    // than waiting for the extension's 'cancelled' ack — turnId-gating in
    // the message listener below is what makes that safe against
    // whatever in-flight messages arrive after.
    sendBtn.addEventListener('click', () => {
      if (activeTurn) {
        const turn = activeTurn;
        vscode.postMessage({ type: 'cancel', turnId: turn.id });
        const stoppedEl = document.createElement('div');
        stoppedEl.className = 'stoppedNote';
        stoppedEl.textContent = 'Stopped.';
        turn.el.appendChild(stoppedEl);
        turn.el.classList.remove('pending');
        activeTurn = null;
        setSending(false);
        return;
      }
      send();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    newThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
    renameThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'renameThread' }));
    freeOption.addEventListener('click', () => vscode.postMessage({ type: 'setFreeMode', value: true }));
    paidOption.addEventListener('click', () => vscode.postMessage({ type: 'setFreeMode', value: false }));
    threadSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'switchThread', id: threadSelect.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        renderThreadList(msg.threads, msg.activeThreadId);
        renderMessages(msg.messages);
        renderFreeMode(msg.freeMode);
        renderThreadStats(msg.threadTokens, msg.threadCost);
        return;
      }
      if (msg.type === 'threadListUpdated') {
        renderThreadList(msg.threads, msg.activeThreadId);
        return;
      }
      if (msg.type === 'attachmentAdded') {
        pendingAttachments.push(msg.attachment);
        renderChips();
        return;
      }

      // Everything below belongs to one in-flight turn — drop it if it's
      // not (or no longer, e.g. after Stop) the turn currently active.
      if (!activeTurn || msg.turnId !== activeTurn.id) return;

      if (msg.type === 'toolStart') {
        handleToolStart(msg.turnId, msg.callId, msg.name, msg.argsSummary);
      } else if (msg.type === 'toolEnd') {
        handleToolEnd(msg.turnId, msg.callId, msg.ok, msg.resultSummary);
      } else if (msg.type === 'textDelta') {
        handleTextDelta(msg.turnId, msg.text);
      } else if (msg.type === 'textReset') {
        handleTextReset(msg.turnId);
      } else if (msg.type === 'reply') {
        finalizeTurn(msg.turnId, msg.reply, msg.model, msg.taskType, msg.usage, msg.elapsedMs);
        renderThreadStats(msg.threadTokens, msg.threadCost);
      } else if (msg.type === 'error') {
        activeTurn.el.remove();
        activeTurn = null;
        setSending(false);
        addMessage('assistant', 'Error: ' + msg.error);
      }
      // 'cancelled' needs no handling — the local Stop click already
      // finalized the UI; this is just the extension's confirmation.
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
