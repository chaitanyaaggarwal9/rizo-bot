// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { callOpenRouter, callWithFallback, ChatMessage, ContentPart, Usage } from './openrouter';
import { modelForMessage, MODEL_FOR_TASK, TaskType, visionModelForTask } from './modelRouter';
import { freeChainForTaskType } from './freeModels';
import { loadSkillsContent } from './skillsLoader';
import { TOOLS, executeTool } from './tools';
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
            await this.handleSend(message.text, message.attachments || []);
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
  private async callModel(apiKey: string, taskType: TaskType, messages: ChatMessage[], hasImage: boolean) {
    if (this.isFreeMode()) {
      if (hasImage) {
        throw new Error(
          "Image attachments need a vision-capable model, and the free tier doesn't currently include one. Switch to Paid mode to use an image in this chat.",
        );
      }
      return callWithFallback(apiKey, freeChainForTaskType(taskType), messages, TOOLS);
    }
    const model = hasImage ? visionModelForTask(taskType) : MODEL_FOR_TASK[taskType];
    return callOpenRouter(apiKey, model, messages, TOOLS);
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

  private async handleSend(text: string, attachments: IncomingAttachment[] = []) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.panel.webview.postMessage({ type: 'error', error: 'No API key provided.' });
      return;
    }

    const startedAt = Date.now();

    try {
      const { taskType } = modelForMessage(text);

      // Only coding-tier messages get skill instructions loaded — general
      // low/medium chat doesn't need engineering-discipline guidance.
      const skillsDir = path.join(this.context.extensionPath, 'skills');
      const skillsContent = loadSkillsContent(skillsDir, text, taskType);

      // Without any system prompt, some models (DeepSeek in particular)
      // default to Chinese on short/ambiguous input — this instruction
      // always applies, regardless of task type.
      const systemParts = [
        'Always respond in English, even if the user writes in another language or the request is ambiguous.',
      ];
      if (skillsContent) systemParts.push(skillsContent);

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
      let userContent: string | ContentPart[] = text;
      if (attachments.length > 0) {
        let combinedText = text;
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

      let answeredBy = '';
      let finalReply = '(no final response — hit the tool-call iteration limit)';
      const totalUsage = emptyUsage();

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const { model: usedModel, message, usage } = await this.callModel(apiKey, taskType, messages, hasImage);
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

        // No progress updates sent to the webview here on purpose — tool
        // activity stays fully hidden behind a plain "Thinking..." until
        // the final answer. The approval prompts themselves (inside
        // executeTool) are unaffected and still show full detail — hiding
        // ambient status text is not the same as hiding what you're
        // actually being asked to approve.
        for (const toolCall of message.tool_calls) {
          const result = await executeTool(this.context, toolCall.function.name, toolCall.function.arguments);
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
        renameThread(this.context, this.activeThreadId, deriveThreadName(text));
        this.panel.webview.postMessage({
          type: 'threadListUpdated',
          threads: listThreads(this.context),
          activeThreadId: this.activeThreadId,
        });
      }

      this.panel.webview.postMessage({
        type: 'reply',
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
      // "User not found" / 401 means OpenRouter didn't recognize the key at
      // all — clear it so the next send re-prompts instead of failing
      // forever on a bad stored key.
      if (/user not found|401|unauthorized/i.test(err.message)) {
        await this.context.secrets.delete(SECRET_KEY);
        this.panel.webview.postMessage({
          type: 'error',
          error: `${err.message} — cleared the stored key. Send your message again to re-enter it.`,
        });
      } else {
        this.panel.webview.postMessage({ type: 'error', error: err.message });
      }
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
    let thinkingEl = null;

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
            const span = document.createElement('span');
            span.textContent = part.text;
            div.appendChild(span);
          }
        }
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
      sendBtn.disabled = true;
      // Tool activity stays hidden — this bubble never updates with
      // per-step detail, only gets replaced by the final reply.
      thinkingEl = addMessage('assistant', 'Thinking...');
      vscode.postMessage({ type: 'send', text, attachments });
    }

    sendBtn.addEventListener('click', send);
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
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      sendBtn.disabled = false;
      if (msg.type === 'reply') {
        addMessage('assistant', msg.reply, msg.model, msg.taskType, msg.usage, msg.elapsedMs);
        renderThreadStats(msg.threadTokens, msg.threadCost);
      } else if (msg.type === 'error') {
        addMessage('assistant', 'Error: ' + msg.error);
      }
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
