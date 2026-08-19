// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { callOpenRouter, callWithFallback, CallOptions, ChatMessage, ContentPart, Usage } from './openrouter';
import { detectTaskType, TaskType } from './modelRouter';
import { freeChainForTaskType } from './freeModels';
import { loadSkillsContent } from './skillsLoader';
import { ToolDefinition, TOOLS, executeTool, summarizeToolCall, summarizeToolResult } from './tools';
import { expandSlashCommand } from './slashCommands';
import { loadProjectInstructions } from './projectInstructions';
import {
  PROVIDERS,
  PROVIDER_ORDER,
  EFFORT_LEVELS,
  EffortLevel,
  DEFAULT_EFFORT,
  defaultModelForProvider,
  isValidProviderModel,
  findVariant,
  supportsReasoning,
} from './providers';
import { estimateCost } from './pricing';
import { getUsage, recordUsage } from './usageStore';
import {
  ThreadData,
  StoredMessage,
  DEFAULT_THREAD_NAME,
  listThreads,
  createThread,
  loadThread,
  saveThreadMessages,
  renameThread,
  deleteThread,
  restoreThread,
  deriveThreadName,
  updateThreadSummary,
  setThreadModel,
  setThreadEffort,
  upgradeThreadTaskType,
  sumThreadTokens,
  sumThreadCost,
} from './threadStore';

// 8 was hitting this wall on ordinary multi-file tasks (portfolio-repo
// incident, Aug 2026) — Codex's own agent core (codex-rs/core) has no
// small fixed per-turn cap at all, which is a real part of why tools like
// it don't feel like they're constantly running out of steps. Not going
// unbounded here though — a genuinely stuck model burning tool calls
// should still stop and hand back to you rather than run up cost forever;
// 30 is a generous multiple of what a normal task (read a few files, make
// a few edits, verify) actually needs.
const MAX_TOOL_ITERATIONS = 30;

const SECRET_KEY = 'rizo.openRouterApiKey';
// Holds exactly one thread — whichever was deleted most recently, cleared
// once restored. Not a stack: Reopen Closed Session only ever means "the
// last thing I closed," same as a browser's Cmd/Ctrl+Shift+T.
const LAST_DELETED_THREAD_KEY = 'rizo.lastDeletedThread';

// Always the cheapest available model, regardless of which provider the
// user picked for the conversation itself — folding old history into a
// summary is internal housekeeping (see maybeSummarize), not a user-facing
// reply, so it shouldn't spend the thread's own (possibly expensive) model.
const SUMMARY_MODEL = PROVIDERS.openai.variants[0].id;

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

// Merges the workspace's root .gitignore into "Mention file from this
// project..."'s exclude pattern — findFiles' own `exclude` param only ever
// means the files.exclude setting (VS Code API docs: "not search.exclude"),
// it doesn't consult .gitignore at all on its own. Simple line-by-line glob
// conversion, not a full gitignore parser (no negation, no nested
// .gitignore files) — good enough to keep a project's own build output/
// vendored deps out of the picker, not a guarantee of exact git semantics.
function gitignoreExcludeGlobs(folder: vscode.Uri): string[] {
  try {
    const content = fs.readFileSync(path.join(folder.fsPath, '.gitignore'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      // Most real .gitignore entries for a directory have no trailing
      // slash ('node_modules', 'dist', not 'dist/') — gitignore itself
      // matches those against files and directories alike. A bare
      // `**/dist` glob only matches something literally named "dist",
      // not anything *inside* it, so a no-trailing-slash directory entry
      // was silently not excluding its own contents. Emitting both forms
      // for every line, regardless of trailing slash, covers "is a file
      // named this" and "is a directory named this" without needing to
      // stat the filesystem to tell which one a given line means.
      .flatMap((line) => {
        const name = line.replace(/\/+$/, '');
        return [`**/${name}`, `**/${name}/**`];
      });
  } catch {
    return [];
  }
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
  // Resolves once the webview's own script has sent 'ready' — a fresh
  // panel's page load is real wall-clock time, so a postMessage sent
  // right after createOrShow() (e.g. addFileToThread invoked cold, before
  // Rizo has ever been opened this session) can otherwise race past the
  // webview's message listener and land in the void with no error and no
  // visible effect.
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;

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

  // Always prompts, unlike getApiKey() (an instance method which only
  // prompts when no key is stored yet) — this is the explicit "I want to
  // enter a different key" path, from the command palette or the
  // in-webview Settings panel. A cancelled/empty prompt leaves whatever
  // key was already stored untouched rather than clearing it.
  public static async changeApiKey(context: vscode.ExtensionContext): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      prompt: 'Enter your OpenRouter API key (get one at openrouter.ai/keys)',
      password: true,
      ignoreFocusOut: true,
    });
    if (!key) return false;
    await context.secrets.store(SECRET_KEY, key.trim());
    return true;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });

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
            this.resolveReady();
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
          case 'deleteThread':
            await this.handleDeleteThread();
            break;
          case 'selectProvider': {
            // First pick for a brand-new thread — always starts on that
            // provider's cheapest variant (providers.ts's variants[0]).
            if (!PROVIDERS[message.provider]) break;
            setThreadModel(this.context, this.activeThreadId, message.provider, defaultModelForProvider(message.provider));
            this.sendInit();
            break;
          }
          case 'selectModel': {
            // In-chat switcher — only ever a variant within the thread's
            // already-locked provider. isValidProviderModel is the actual
            // enforcement; the webview never renders another company's
            // models into this dropdown in the first place (see getHtml).
            const thread = loadThread(this.context, this.activeThreadId);
            if (thread?.provider && isValidProviderModel(thread.provider, message.model)) {
              setThreadModel(this.context, this.activeThreadId, thread.provider, message.model);
              this.sendInit();
            }
            break;
          }
          case 'selectEffort': {
            if ((EFFORT_LEVELS as readonly string[]).includes(message.effort)) {
              setThreadEffort(this.context, this.activeThreadId, message.effort);
              this.sendInit();
            }
            break;
          }
          case 'changeApiKey':
            await ChatPanel.changeApiKey(this.context);
            break;
          case 'setSendKey':
            if (message.value === 'enter' || message.value === 'ctrlEnter') {
              await vscode.workspace
                .getConfiguration('rizo')
                .update('composer.sendKey', message.value, vscode.ConfigurationTarget.Global);
              this.sendSettingsUpdate();
            }
            break;
          case 'setFocusMode':
            await vscode.workspace
              .getConfiguration('rizo')
              .update('view.focusMode', !!message.value, vscode.ConfigurationTarget.Global);
            this.sendSettingsUpdate();
            break;
          case 'openExtensionSettings':
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ChaitanyaAggarwal.rizo');
            break;
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private sendInit() {
    const thread = loadThread(this.context, this.activeThreadId);
    const messages = thread?.messages || [];
    const usage = getUsage(this.context);
    this.panel.webview.postMessage({
      type: 'init',
      threads: listThreads(this.context),
      activeThreadId: this.activeThreadId,
      messages,
      // Undefined until the provider picker has been used once for this
      // thread — the webview shows the picker instead of the composer.
      provider: thread?.provider,
      model: thread?.model,
      effort: thread?.effort || DEFAULT_EFFORT,
      threadTokens: sumThreadTokens(messages),
      threadCost: sumThreadCost(messages),
      dayTokens: usage.dayTokens,
      monthCost: usage.monthCost,
      // Real VS Code settings (contributes.configuration), not workspaceState
      // — so they're editable from either the in-webview Settings panel or
      // VS Code's own Settings UI, and stay in sync either way (this always
      // re-reads live rather than caching what the panel last set).
      sendKey: vscode.workspace.getConfiguration('rizo').get<string>('composer.sendKey', 'enter'),
      focusMode: vscode.workspace.getConfiguration('rizo').get<boolean>('view.focusMode', false),
    });
  }

  // A Settings-panel toggle used to go through sendInit(), which also
  // re-renders the whole message list and resets activeTurn/messageQueue
  // client-side — fine on a fresh init, but flipping a setting mid-turn
  // silently dropped the in-flight reply's tracking and let a second
  // send() start a concurrent handleSend() for the same thread. This only
  // ever touches the two settings values, never messages/turn state.
  private sendSettingsUpdate() {
    this.panel.webview.postMessage({
      type: 'settingsUpdate',
      sendKey: vscode.workspace.getConfiguration('rizo').get<string>('composer.sendKey', 'enter'),
      focusMode: vscode.workspace.getConfiguration('rizo').get<boolean>('view.focusMode', false),
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

  // Modal confirm first (still meaningfully more friction than Rename —
  // an accidental double-click on Delete shouldn't hinge on noticing a
  // toast afterward), then an Undo toast for the case you actually
  // change your mind. If the deleted thread was the active one, falls
  // back to the next most-recently-updated thread, or a brand-new one if
  // that was the last chat left.
  private async handleDeleteThread() {
    const thread = loadThread(this.context, this.activeThreadId);
    const confirm = await vscode.window.showWarningMessage(
      `Delete "${thread?.name || 'this chat'}"?`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') return;

    if (thread) await this.context.globalState.update(LAST_DELETED_THREAD_KEY, thread);
    deleteThread(this.context, this.activeThreadId);
    const remaining = listThreads(this.context);
    this.activeThreadId = remaining.length > 0 ? remaining[0].id : createThread(this.context).id;
    this.sendInit();

    if (thread) {
      // Bound to this exact thread via the closure, not "whatever's in
      // the shared stash" — VS Code stacks multiple non-modal toasts, so
      // an older toast's Undo is still clickable after a second delete
      // has already overwritten LAST_DELETED_THREAD_KEY with a different
      // thread. Going through the closure instead means clicking *this*
      // toast always restores *this* thread, regardless of what happened
      // to the shared stash in the meantime.
      vscode.window.showInformationMessage(`Deleted "${thread.name}".`, 'Undo').then((choice) => {
        if (choice === 'Undo') this.restoreSpecificThread(thread);
      });
    }
  }

  // Shared by the Undo toast above (bound to the exact thread that toast
  // is about) and restoreLastDeleted below (best-effort "whatever I most
  // recently deleted," for the standing command).
  private async restoreSpecificThread(thread: ThreadData) {
    // Only clear the stash if it's still this same thread — a second
    // delete may have already overwritten it with a different one, which
    // this restore has no business touching.
    if (this.context.globalState.get<ThreadData>(LAST_DELETED_THREAD_KEY)?.id === thread.id) {
      await this.context.globalState.update(LAST_DELETED_THREAD_KEY, undefined);
    }
    restoreThread(this.context, thread);
    this.activeThreadId = thread.id;
    // Self-healing even without this (activeThreadId is already updated
    // by the time the webview's own 'ready' handler fires its own
    // sendInit), but awaiting ready first avoids a redundant/out-of-order
    // postMessage on a cold panel — see addFileToThread's comment.
    await this.ready;
    this.sendInit();
  }

  // The standing rizo.reopenClosedSession command (extension.ts) lands
  // here — "whatever I most recently deleted," last-one-wins if more than
  // one delete happened since. The Undo toast bypasses this entirely and
  // restores its own specific thread directly (see handleDeleteThread).
  public async restoreLastDeleted() {
    const thread = this.context.globalState.get<ThreadData>(LAST_DELETED_THREAD_KEY);
    if (!thread) {
      vscode.window.showInformationMessage('No recently closed chat to reopen.');
      return;
    }
    await this.restoreSpecificThread(thread);
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

  // The Free provider routes through the same fallback chain it always
  // did (any individual free model 429s or comes back empty far more often
  // than a paid one); every other provider is a direct call to the exact
  // variant the user picked — no fallback, same "hard pin" philosophy the
  // old coding tier used, just applied to whichever company is active.
  // hasImage is validated against the variant's vision flag by the caller
  // (handleSend) before this is ever reached, so a vision-incapable model
  // never silently gets an image it can't see.
  private async callModel(
    apiKey: string,
    provider: string,
    model: string,
    taskType: TaskType,
    messages: ChatMessage[],
    hasImage: boolean,
    tools: ToolDefinition[],
    options: CallOptions = {},
  ) {
    if (provider === 'free') {
      if (hasImage) {
        throw new Error(
          "Image attachments need a vision-capable model, and the Free provider doesn't currently include one. Start a new chat on a different provider to use an image.",
        );
      }
      return callWithFallback(apiKey, freeChainForTaskType(taskType), messages, tools, options);
    }
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
    const exclude = `{${[
      '**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**', '**/build/**',
      ...gitignoreExcludeGlobs(folder.uri),
    ].join(',')}}`;
    const files = await vscode.workspace.findFiles('**/*', exclude, 500);
    const items = files.map((uri) => ({
      label: path.basename(uri.fsPath),
      description: path.relative(folder.uri.fsPath, uri.fsPath),
      uri,
    }));
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Mention a file from this project' });
    if (!choice) return;
    await this.readAndSendAttachment(choice.uri.fsPath);
  }

  // Entry point for the Explorer/editor-tab "Add File to Rizo Thread"
  // context-menu command (extension.ts) — same end state as "Mention file
  // from this project..." (a pending chip in the composer, not an
  // immediate send), just reachable without opening that menu first.
  public async addFileToThread(fsPath: string) {
    this.panel.reveal();
    await this.ready;
    await this.readAndSendAttachment(fsPath);
  }

  // Entry point for the TODO CodeLens ("Implement with Rizo") — fills the
  // composer and focuses it, but deliberately does NOT send automatically.
  // A one-click "go implement this" is what Codex's own CodeLens does, but
  // that also means one accidental/curious click spends real tokens on
  // whichever paid model the active thread is on with zero review. Prefill
  // + let the user hit Send themselves is the same non-auto-send precedent
  // "Mention file from this project..." already sets for pending content.
  public async prefillComposer(text: string) {
    this.panel.reveal();
    await this.ready;
    this.panel.webview.postMessage({ type: 'prefillComposer', text });
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
  private async maybeSummarize(apiKey: string, threadId: string) {
    const thread = loadThread(this.context, threadId);
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
      const { message } = await callOpenRouter(apiKey, SUMMARY_MODEL, prompt);
      const newSummary = (message.content as string) || thread.summary || '';
      if (newSummary) updateThreadSummary(this.context, threadId, newSummary, foldEnd);
    } catch {
      // Best-effort — the thread just keeps replaying full history until
      // this succeeds on a later turn.
    }
  }

  private async handleSend(text: string, turnId: string, attachments: IncomingAttachment[] = []) {
    // Captured once, up front, and used for every read/write this turn
    // does — never this.activeThreadId again after this line. A turn can
    // outlive the panel's "current" thread (the user switches threads,
    // or deletes this one, while a reply is still in flight); without
    // this, the turn-start snapshot of messages gets saved under
    // whatever thread happens to be active when the turn *finishes*,
    // silently corrupting an unrelated thread's history.
    const threadId = this.activeThreadId;

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.panel.webview.postMessage({ type: 'error', error: 'No API key provided.', turnId });
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    this.activeAbortController = controller;
    // Hoisted above the try so the catch block can still persist it on a
    // genuine failure (network error, etc.) — see the catch block below.
    let userContent: string | ContentPart[] | undefined;

    const thread = loadThread(this.context, threadId);
    if (!thread?.provider || !thread?.model) {
      this.panel.webview.postMessage({ type: 'error', error: 'Pick a provider for this chat first.', turnId });
      return;
    }
    const provider = thread.provider;
    const model = thread.model;
    const effort: EffortLevel = (thread.effort as EffortLevel) || DEFAULT_EFFORT;

    try {
      // /commit, /review, /test expand to a canned prompt before anything
      // else runs — forced into the 'coding' task type regardless of
      // keyword match, since typing the command IS the signal. An
      // unrecognized "/foo" isn't an error, it just falls through as
      // literal text. taskType no longer picks a model (the provider
      // picker/switcher does that, explicitly) — it only decides which
      // skill files load below and, for the Free provider, which fallback
      // chain to try.
      const slashExpansion = expandSlashCommand(text);
      const effectiveText = slashExpansion ?? text;
      const messageTaskType: TaskType = slashExpansion ? 'coding' : detectTaskType(effectiveText);
      // Sticky: a short follow-up ("yes", an email address, "continue")
      // rarely contains a coding keyword on its own, but a task that
      // started coding-flavored doesn't stop being one — see
      // upgradeThreadTaskType's comment in threadStore.ts. Persists the
      // upgrade so it survives past this turn too.
      const taskType: TaskType = thread.taskType === 'coding' ? 'coding' : messageTaskType;
      if (messageTaskType === 'coding') upgradeThreadTaskType(this.context, threadId, 'coding');

      // Only coding-classified messages get skill instructions loaded —
      // general chat doesn't need engineering-discipline guidance. This
      // applies the same way regardless of which provider is answering, so
      // switching companies never costs you the skill files.
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
      userContent = effectiveText;
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
      if (hasImage && provider !== 'free') {
        const variant = findVariant(provider, model);
        if (variant?.vision === false) {
          this.panel.webview.postMessage({
            type: 'error',
            turnId,
            error: `${variant.label} isn't vision-capable — switch to a different ${PROVIDERS[provider].label} variant to use an image in this chat.`,
          });
          return;
        }
      }

      // rizo.permissions.disabledTools — filtered out here so the model is
      // never even offered a disabled tool (no wasted round-trip);
      // executeTool has its own check as a backstop.
      const disabledTools = vscode.workspace.getConfiguration('rizo').get<string[]>('permissions.disabledTools', []);
      const enabledTools = TOOLS.filter((t) => !disabledTools.includes(t.function.name));

      let answeredBy = '';
      // Kept short and explicit on purpose — this exact string gets
      // persisted and replayed as this turn's assistant reply in every
      // future turn's history (see threadStore.ts's comment on why only
      // the final exchange is stored), so a vague placeholder here would
      // misinform every subsequent turn about what actually happened.
      let finalReply = "I ran out of steps before finishing (hit the tool-call limit for one turn) — say 'continue' and I'll pick back up.";
      const totalUsage = emptyUsage();

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (this.cancelledTurnId === turnId) break;

        const { model: usedModel, message, usage } = await this.callModel(apiKey, provider, model, taskType, messages, hasImage, enabledTools, {
          signal: controller.signal,
          // Dropped for a variant that doesn't support it (providers.ts's
          // ModelVariant.reasoning === false) rather than sent and possibly
          // rejected — and callWithFallback (the Free provider's path)
          // never forwards this field at all regardless, see openrouter.ts.
          reasoningEffort: supportsReasoning(provider, model) ? effort : undefined,
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

      // Folds this turn's cost into the running today/this-month totals
      // the header always shows, regardless of which provider answered or
      // which thread this was — see usageStore.ts.
      const turnCost = estimateCost(answeredBy, totalUsage.promptTokens, totalUsage.completionTokens);
      const globalUsage = recordUsage(this.context, totalUsage.totalTokens, turnCost);

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
      saveThreadMessages(this.context, threadId, updated);

      // Auto-name the thread from its first message, same as most chat
      // apps — only when it's still the default name, never overriding a
      // name you set yourself via Rename.
      if ((thread?.messages.length ?? 0) === 0 && thread?.name === DEFAULT_THREAD_NAME) {
        renameThread(this.context, threadId, deriveThreadName(effectiveText));
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
        dayTokens: globalUsage.dayTokens,
        monthCost: globalUsage.monthCost,
      });

      // Fire-and-forget: never makes the user wait on housekeeping. See
      // maybeSummarize's own comment for what this actually does.
      void this.maybeSummarize(apiKey, threadId);
    } catch (err: any) {
      // Stop was clicked — the webview already showed "Stopped." locally
      // (see send()'s cancel handling), this just confirms the extension
      // side actually unwound rather than silently continuing. Deliberately
      // NOT persisted below — an aborted turn is an intentional user
      // action with its own UX (the "Stopped." note), not a failure the
      // next turn needs a history record of.
      if (err.name === 'AbortError') {
        this.panel.webview.postMessage({ type: 'cancelled', turnId });
      } else if (/user not found|401|unauthorized/i.test(err.message)) {
        // "User not found" / 401 means OpenRouter didn't recognize the key
        // at all — clear it so the next send re-prompts instead of failing
        // forever on a bad stored key.
        await this.context.secrets.delete(SECRET_KEY);
        const error = `${err.message} — cleared the stored key. Send your message again to re-enter it.`;
        this.panel.webview.postMessage({ type: 'error', turnId, error });
        this.persistFailedTurn(threadId, userContent, error);
      } else {
        this.panel.webview.postMessage({ type: 'error', turnId, error: err.message });
        this.persistFailedTurn(threadId, userContent, `Error: ${err.message}`);
      }
    } finally {
      // Only clear if this turn still owns the controller — a rapid
      // second send() before this one's finally runs would otherwise wipe
      // out the newer turn's own controller.
      if (this.activeAbortController === controller) this.activeAbortController = undefined;
    }
  }

  // A turn that throws (network error, etc.) used to vanish from history
  // entirely — saveThreadMessages only ever ran on the success path, so
  // the *next* turn's context had a silent gap where "you asked X, it
  // failed" should have been. userContent is undefined only if the error
  // happened before the message was even built (e.g. no API key) — nothing
  // to record in that case, so this just no-ops.
  private persistFailedTurn(threadId: string, userContent: string | ContentPart[] | undefined, errorText: string) {
    if (userContent === undefined) return;
    const thread = loadThread(this.context, threadId);
    if (!thread) return;
    const updated: StoredMessage[] = [
      ...thread.messages,
      { role: 'user', content: userContent },
      { role: 'assistant', content: errorText },
    ];
    saveThreadMessages(this.context, threadId, updated);
  }

  private getHtml(): string {
    const nonce = getNonce();
    const iconPath = path.join(this.context.extensionPath, 'icon.png');
    const iconDataUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
    const mascotPath = path.join(this.context.extensionPath, 'assets', 'mascot.png');
    const mascotDataUri = `data:image/png;base64,${fs.readFileSync(mascotPath).toString('base64')}`;
    // Trimmed view of providers.ts handed to the webview once — it renders
    // the provider picker grid and each provider's own variant dropdown
    // straight from this, so there's exactly one place (providers.ts) that
    // defines the catalog and no risk of the webview's copy drifting from
    // the extension side's enforcement in isValidProviderModel.
    const providerCatalog = PROVIDER_ORDER.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      variants: PROVIDERS[id].variants.map((v) => ({
        id: v.id,
        label: v.label,
        tagline: v.tagline,
        reasoning: v.reasoning !== false,
      })),
    }));
    const providerCatalogJson = JSON.stringify(providerCatalog);
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
  /* Destructive — the only iconBtn that discards data with no undo
     (handleDeleteThread's modal confirm is the safety net, not this), so
     it gets the same warning color the errorForeground already uses
     elsewhere in this stylesheet rather than blending in with New/Rename. */
  #deleteThreadBtn:hover { background: rgba(241, 76, 76, 0.15); color: var(--vscode-errorForeground, #f14c4c); border-color: rgba(241, 76, 76, 0.4); }

  /* Always-visible spend readout — its own row, top-left, above the
     thread-picker row, global across every thread and provider (see
     usageStore.ts). Resets itself (today at midnight, cost on the 1st)
     with no action needed — the label says "today"/"this month" so
     that's never ambiguous either. */
  #usageBar { padding: 8px 12px 0; }
  #usageStats {
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  /* Model pill — sits where the old Free/Paid toggle did, but now shows
     "<Provider> · <Variant>" for the thread's locked provider and opens a
     dropdown of ONLY that provider's own variants. There is no control
     anywhere in this dropdown that can switch to a different company —
     that's a one-time choice made once in #providerPicker, when the
     thread had no provider yet. See providers.ts for why: it keeps every
     swap within one tool-calling convention/system-prompt format/context
     window, which cross-company switching was not. */
  #modelBar { display: flex; justify-content: center; gap: 8px; padding: 8px 12px 0; }
  #modelPillWrap, #effortPillWrap { position: relative; }
  #modelPill, #effortPill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 999px;
    padding: 5px 14px;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }
  #modelPill:hover, #effortPill:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  #modelPill .chev, #effortPill .chev { opacity: 0.6; font-size: 9px; }
  #modelDropdown, #effortDropdown {
    display: none;
    position: absolute;
    top: 100%;
    margin-top: 4px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 8px;
    padding: 4px;
    min-width: 180px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    z-index: 10;
  }
  #modelDropdown { min-width: 220px; }
  #modelDropdown.open, #effortDropdown.open { display: block; }

  /* Settings — gear icon in threadBar, same dropdown-shell pattern as the
     model/effort pills above (absolute-positioned panel, not a modal). */
  #settingsWrap { position: relative; }
  #settingsPanel {
    display: none;
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 8px;
    padding: 6px;
    min-width: 240px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    z-index: 20;
  }
  #settingsPanel.open { display: block; }
  .settingsRow { padding: 6px 8px; }
  .settingsLabel { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
  .settingsBtn {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 5px;
    padding: 7px 8px;
    font-size: 12px;
    cursor: pointer;
    color: var(--vscode-dropdown-foreground);
  }
  .settingsBtn:hover { background: var(--vscode-list-hoverBackground); }
  .settingsDivider { height: 1px; background: var(--vscode-widget-border); margin: 4px 2px; }
  .segmented { display: flex; border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; }
  .segmentedOption {
    flex: 1;
    background: transparent;
    border: none;
    padding: 5px 6px;
    font-size: 11px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
  }
  .segmentedOption:hover:not(.active) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .segmentedOption.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .segmentedOption + .segmentedOption { border-left: 1px solid var(--vscode-widget-border); }
  .variantOption {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 5px;
    padding: 6px 10px;
    cursor: pointer;
    color: var(--vscode-dropdown-foreground);
  }
  .variantOption:hover { background: var(--vscode-list-hoverBackground); }
  .variantOption .vLabel { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
  .variantOption .vTagline { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .variantOption .vCheck { color: #4CA39E; font-size: 11px; }

  /* Provider picker — replaces the empty state on a brand-new thread until
     one company is chosen. Deliberately not a dropdown: it's a one-time,
     deliberate decision, not a quick toggle, so it gets the same visual
     weight as picking a chat to start. */
  #providerPicker {
    flex: 1;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
  }
  #providerPicker.visible { display: flex; }
  #providerPicker .pickerTitle { font-size: 13.5px; font-weight: 600; }
  #providerPicker .pickerHint { font-size: 11.5px; color: var(--vscode-descriptionForeground); max-width: 320px; }
  #providerGrid { display: grid; grid-template-columns: repeat(2, minmax(120px, 1fr)); gap: 8px; max-width: 360px; width: 100%; }
  .providerOption {
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 10px;
    padding: 12px 10px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .providerOption:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1)); }
  .providerOption .pTagline { display: block; margin-top: 3px; font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground); }

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

  /* --- Motion --- */
  /* Every new-content animation below is opacity-only, 150-200ms,
     ease-out — no slide/scale. Same shape independently used by both
     Claude Code's and Codex's own VS Code extensions (checked their
     shipped webview CSS directly), not a guess at what "smooth" means. */
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes pulseThinking { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes blinkCursor { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .msg, .transcriptLine { animation: none; }
    .thinkingDot, .streamCursor { animation: none; opacity: 0.6; }
  }

  /* --- Messages --- */
  #messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; animation: .18s ease-out fadeIn; }
  .msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-bottom-left-radius: 4px; }
  .msg .attachedImg { max-width: 220px; max-height: 220px; border-radius: 8px; display: block; margin-top: 6px; }

  /* --- Live tool-call transcript --- */
  .transcript { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  /* Focus view (rizo.view.focusMode) — hides tool-call activity, leaving
     only prompts and final answers. Live tool lines are still created
     normally underneath; this is purely visual, so turning it off mid-turn
     doesn't lose anything. */
  body.focusMode .transcript { display: none; }
  .transcriptLine {
    font-size: 11.5px;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(128,128,128,0.08);
    white-space: pre-wrap;
    word-break: break-word;
    animation: .15s ease-out fadeIn;
  }
  .transcriptLine.running { opacity: 0.75; }
  .transcriptLine.running::after { content: ' …'; }
  .transcriptLine.failed { color: var(--vscode-errorForeground, #f14c4c); }
  .streamedText { display: block; }

  /* "Thinking…" replaced with 3 dots pulsing in sequence — same
     opacity-oscillation technique both reference extensions use for
     their own waiting state (Claude: 1.2s cycle; Codex: 1.75-3s), just
     staggered per-dot here instead of one shared pulse. */
  .thinkingDots { display: inline-flex; gap: 3px; align-items: center; height: 13px; }
  .thinkingDot {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--vscode-descriptionForeground);
    animation: 1.2s ease-in-out infinite pulseThinking;
  }
  .thinkingDot:nth-child(2) { animation-delay: 0.15s; }
  .thinkingDot:nth-child(3) { animation-delay: 0.3s; }

  /* Blinking cursor at the trailing edge of actively-streaming text —
     same 1s linear blink both reference extensions use for theirs.
     Removed the instant a turn finalizes (see finalizeTurn). */
  .streamCursor {
    display: inline-block;
    width: 2px; height: 1em;
    margin-left: 1px;
    vertical-align: text-bottom;
    background: var(--vscode-foreground);
    animation: 1s linear infinite blinkCursor;
  }

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
    justify-content: space-between;
    gap: 8px;
    padding: 6px 6px 4px;
    font-size: 11px;
    opacity: 0.55;
  }
  #queueNote { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div id="usageBar"><span id="usageStats"></span></div>
  <div id="threadBar">
    <select id="threadSelect"></select>
    <button class="iconBtn" id="newThreadBtn">New</button>
    <button class="iconBtn" id="renameThreadBtn">Rename</button>
    <button class="iconBtn" id="deleteThreadBtn" title="Delete this chat">Delete</button>
    <div id="settingsWrap">
      <button class="iconBtn" id="settingsBtn" title="Settings">&#9881;</button>
      <div id="settingsPanel">
        <button class="settingsBtn" id="changeApiKeyBtn">Change OpenRouter API Key&hellip;</button>
        <div class="settingsDivider"></div>
        <div class="settingsRow">
          <div class="settingsLabel">Send message with</div>
          <div class="segmented" id="sendKeySegmented">
            <button class="segmentedOption" data-value="enter">Enter</button>
            <button class="segmentedOption" data-value="ctrlEnter">Ctrl/Cmd+Enter</button>
          </div>
        </div>
        <div class="settingsRow">
          <div class="settingsLabel">Focus view</div>
          <div class="segmented" id="focusModeSegmented">
            <button class="segmentedOption" data-value="off">Off</button>
            <button class="segmentedOption" data-value="on">On &mdash; hide tool activity</button>
          </div>
        </div>
        <div class="settingsDivider"></div>
        <button class="settingsBtn" id="openSettingsBtn">More settings&hellip;</button>
      </div>
    </div>
  </div>
  <div id="modelBar" style="visibility:hidden">
    <div id="modelPillWrap">
      <button id="modelPill"><span id="modelPillLabel"></span><span class="chev">&#9662;</span></button>
      <div id="modelDropdown"></div>
    </div>
    <div id="effortPillWrap">
      <button id="effortPill"><span id="effortPillLabel"></span><span class="chev">&#9662;</span></button>
      <div id="effortDropdown"></div>
    </div>
  </div>
  <div id="providerPicker">
    <div class="pickerTitle">Choose a provider for this chat</div>
    <div class="pickerHint">Locked in for this chat once picked — you can switch variants within it anytime, but not to a different provider. Start a new chat for that.</div>
    <div id="providerGrid"></div>
  </div>
  <div id="emptyState">
    <img src="${mascotDataUri}" alt="">
    <div class="hint">Ask a question, or point Rizo at a file or a task.<br>Every reply in this chat comes from the provider you picked above.</div>
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
    <div id="statsBar"><span id="queueNote"></span><span id="tokenStats"></span></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const PROVIDER_CATALOG = ${providerCatalogJson};
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('inputBox');
    const sendBtn = document.getElementById('sendBtn');
    const threadSelect = document.getElementById('threadSelect');
    const newThreadBtn = document.getElementById('newThreadBtn');
    const renameThreadBtn = document.getElementById('renameThreadBtn');
    const deleteThreadBtn = document.getElementById('deleteThreadBtn');
    const usageStatsEl = document.getElementById('usageStats');
    const modelBarEl = document.getElementById('modelBar');
    const modelPillEl = document.getElementById('modelPill');
    const modelPillLabelEl = document.getElementById('modelPillLabel');
    const modelDropdownEl = document.getElementById('modelDropdown');
    const effortPillEl = document.getElementById('effortPill');
    const effortPillLabelEl = document.getElementById('effortPillLabel');
    const effortDropdownEl = document.getElementById('effortDropdown');
    const providerPickerEl = document.getElementById('providerPicker');
    const providerGridEl = document.getElementById('providerGrid');
    const tokenStats = document.getElementById('tokenStats');
    const queueNoteEl = document.getElementById('queueNote');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanelEl = document.getElementById('settingsPanel');
    const changeApiKeyBtn = document.getElementById('changeApiKeyBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const sendKeySegmented = document.getElementById('sendKeySegmented');
    const focusModeSegmented = document.getElementById('focusModeSegmented');
    // Mirror rizo.composer.sendKey / rizo.view.focusMode — real VS Code
    // settings (see sendInit), not workspaceState, so they're also editable
    // from VS Code's own Settings UI. Defaults match package.json's.
    let currentSendKey = 'enter';
    let currentFocusMode = false;
    const EFFORT_LEVELS = [
      { id: 'low', label: 'Low', tagline: 'Fast, cheapest — trivial follow-ups' },
      { id: 'medium', label: 'Medium', tagline: 'Balanced — the default' },
      { id: 'high', label: 'High', tagline: 'Slower, priciest — hard problems' },
    ];
    // Which provider/model/effort this thread is currently on — null/default
    // until the picker has been used once. Everything that gates sending
    // (the composer) or populates the switchers reads these.
    let currentProvider = null;
    let currentModel = null;
    let currentEffort = 'medium';
    // Messages typed while a turn is already running — send() pushes here
    // instead of dispatching immediately (the input box stays enabled
    // during a turn now, unlike before). dispatchNextQueued() drains one
    // per turn completion. Cleared (not drained) on Stop — an explicit
    // cancel is "abandon this direction," not "skip to the next queued
    // thing." Cleared on thread switch too, since a queue belongs to
    // whichever thread's turn it was queued behind.
    let messageQueue = [];
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
      // Stays enabled while a turn is running now — send() queues instead
      // of dispatching immediately when one's already in flight (see
      // messageQueue). Only actually disabled with no provider picked
      // yet, since there's nothing to send to at all.
      inputEl.disabled = !currentProvider;
    }

    // Builds the one bubble a turn lives in for its whole lifecycle:
    // transcript lines appended as tool calls happen, then streamed text,
    // then (finalizeTurn) the rendered final content — same DOM node
    // throughout, never removed-and-replaced.
    // The 3-dot pulse standing in for "Thinking…" — same opacity-
    // oscillation technique as the CSS's .thinkingDot, just markup.
    const THINKING_HTML = '<span class="thinkingDots"><span class="thinkingDot"></span><span class="thinkingDot"></span><span class="thinkingDot"></span></span>';

    function startTurn(turnId) {
      const el = document.createElement('div');
      el.className = 'msg assistant pending';
      const transcriptEl = document.createElement('div');
      transcriptEl.className = 'transcript';
      const textEl = document.createElement('span');
      textEl.className = 'streamedText';
      textEl.innerHTML = THINKING_HTML;
      el.appendChild(transcriptEl);
      el.appendChild(textEl);
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // bufferEl is the inner span actually holding streamed text, created
      // lazily on the first delta (see handleTextDelta) — kept separate
      // from the trailing .streamCursor span so writing new text never
      // clobbers the cursor node.
      activeTurn = { id: turnId, el, transcriptEl, textEl, bufferEl: null, toolLines: new Map(), textBuffer: '', hasText: false };
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
      if (!activeTurn.hasText) {
        activeTurn.textBuffer = '';
        activeTurn.hasText = true;
        // First real token — swap the thinking-dots out for the streamed-
        // content span + a trailing blinking cursor (same 1s linear blink
        // pattern Claude Code's and Codex's own extensions both use at
        // the trailing edge of in-progress text).
        activeTurn.textEl.innerHTML = '<span class="streamedContent"></span><span class="streamCursor"></span>';
        activeTurn.bufferEl = activeTurn.textEl.querySelector('.streamedContent');
      }
      activeTurn.textBuffer += text;
      activeTurn.bufferEl.textContent = activeTurn.textBuffer;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // A model failed after already streaming some text — clear it before
    // the next fallback model's fresh attempt starts, so the two don't
    // visually run together as one garbled reply.
    function handleTextReset(turnId) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      activeTurn.textBuffer = '';
      activeTurn.hasText = false;
      activeTurn.bufferEl = null;
      activeTurn.textEl.innerHTML = THINKING_HTML;
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
      dispatchNextQueued();
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
      // Queue is thread-scoped too — a message queued behind this thread's
      // turn doesn't belong in whichever thread you're switching to.
      activeTurn = null;
      messageQueue = [];
      renderQueueNote();
      setSending(false);
      messagesEl.innerHTML = '';
      emptyStateEl.style.display = messages.length === 0 ? 'flex' : 'none';
      messagesEl.style.display = messages.length === 0 ? 'none' : 'flex';
      for (const m of messages) {
        addMessage(m.role, m.content, m.model, m.taskType, m.totalTokens ? { totalTokens: m.totalTokens } : null);
      }
    }

    function findProvider(id) {
      return PROVIDER_CATALOG.find((p) => p.id === id);
    }

    // Built once — the six providers never change at runtime, only which
    // one this thread has picked does.
    function renderProviderGrid() {
      providerGridEl.innerHTML = '';
      for (const p of PROVIDER_CATALOG) {
        const btn = document.createElement('button');
        btn.className = 'providerOption';
        btn.textContent = p.label;
        const tag = document.createElement('span');
        tag.className = 'pTagline';
        tag.textContent = p.id === 'free' ? 'No cost, best-effort quality' : p.variants[0].label + ' to start';
        btn.appendChild(tag);
        btn.addEventListener('click', () => vscode.postMessage({ type: 'selectProvider', provider: p.id }));
        providerGridEl.appendChild(btn);
      }
    }

    // Rebuilds the switcher dropdown for whichever provider this thread is
    // locked to — deliberately reads ONLY that one provider's variants
    // (findProvider(provider).variants), never the full catalog, so there
    // is no code path in the webview that could render a different
    // company's models into this list.
    function renderModelSwitch(provider, model) {
      if (!provider) {
        modelBarEl.style.visibility = 'hidden';
        return;
      }
      modelBarEl.style.visibility = 'visible';
      const p = findProvider(provider);
      const variant = p && p.variants.find((v) => v.id === model);
      modelPillLabelEl.textContent = p ? p.label + ' · ' + (variant ? variant.label : '') : '';

      modelDropdownEl.innerHTML = '';
      if (!p) return;
      for (const v of p.variants) {
        const btn = document.createElement('button');
        btn.className = 'variantOption';
        const labelRow = document.createElement('span');
        labelRow.className = 'vLabel';
        labelRow.textContent = v.label;
        if (v.id === model) {
          const check = document.createElement('span');
          check.className = 'vCheck';
          check.textContent = '✓';
          labelRow.appendChild(check);
        }
        const tagline = document.createElement('span');
        tagline.className = 'vTagline';
        tagline.textContent = v.tagline;
        btn.appendChild(labelRow);
        btn.appendChild(tagline);
        btn.addEventListener('click', () => {
          modelDropdownEl.classList.remove('open');
          if (v.id !== model) vscode.postMessage({ type: 'selectModel', model: v.id });
        });
        modelDropdownEl.appendChild(btn);
      }
    }

    // Hidden entirely (not just disabled) when the current variant's
    // reasoning flag is false (see providers.ts) — Effort has no
    // server-side effect there, so showing a control that silently does
    // nothing would be worse than not showing it. Currently that's only
    // the Free provider's one Auto variant.
    function renderEffortSwitch(provider, model, effort) {
      const p = findProvider(provider);
      const variant = p && p.variants.find((v) => v.id === model);
      const supported = !!variant && variant.reasoning;
      effortPillEl.parentElement.style.display = supported ? '' : 'none';
      if (!supported) return;

      const current = EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[1];
      effortPillLabelEl.textContent = 'Effort: ' + current.label;

      effortDropdownEl.innerHTML = '';
      for (const e of EFFORT_LEVELS) {
        const btn = document.createElement('button');
        btn.className = 'variantOption';
        const labelRow = document.createElement('span');
        labelRow.className = 'vLabel';
        labelRow.textContent = e.label;
        if (e.id === effort) {
          const check = document.createElement('span');
          check.className = 'vCheck';
          check.textContent = '✓';
          labelRow.appendChild(check);
        }
        const tagline = document.createElement('span');
        tagline.className = 'vTagline';
        tagline.textContent = e.tagline;
        btn.appendChild(labelRow);
        btn.appendChild(tagline);
        btn.addEventListener('click', () => {
          effortDropdownEl.classList.remove('open');
          if (e.id !== effort) vscode.postMessage({ type: 'selectEffort', effort: e.id });
        });
        effortDropdownEl.appendChild(btn);
      }
    }

    // The single entry point for "which provider/model/effort is this
    // thread on" — called from every init/reply so the picker, pills,
    // dropdowns, and composer-enabled state can never drift out of sync
    // with each other.
    function applyProviderState(provider, model, effort) {
      currentProvider = provider || null;
      currentModel = model || null;
      currentEffort = effort || 'medium';
      providerPickerEl.classList.toggle('visible', !currentProvider);
      // renderMessages() (called just before this, on every init) already
      // decided emptyState/messages visibility from the message count —
      // only override it here for the "no provider yet" case, so the
      // picker isn't competing with the empty-state hint on screen at once.
      if (!currentProvider) {
        emptyStateEl.style.display = 'none';
        messagesEl.style.display = 'none';
      }
      renderModelSwitch(currentProvider, currentModel);
      renderEffortSwitch(currentProvider, currentModel, currentEffort);
      setSending(false);
    }

    modelPillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      effortDropdownEl.classList.remove('open');
      modelDropdownEl.classList.toggle('open');
    });
    effortPillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.toggle('open');
    });
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.remove('open');
      settingsPanelEl.classList.toggle('open');
    });
    settingsPanelEl.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.remove('open');
      settingsPanelEl.classList.remove('open');
    });

    function renderSettingsState(sendKey, focusMode) {
      currentSendKey = sendKey || 'enter';
      currentFocusMode = !!focusMode;
      for (const btn of sendKeySegmented.children) {
        btn.classList.toggle('active', btn.dataset.value === currentSendKey);
      }
      for (const btn of focusModeSegmented.children) {
        btn.classList.toggle('active', btn.dataset.value === (currentFocusMode ? 'on' : 'off'));
      }
      document.body.classList.toggle('focusMode', currentFocusMode);
      inputEl.placeholder = currentSendKey === 'ctrlEnter'
        ? 'Message... (Ctrl/Cmd+Enter to send, Enter for a new line)'
        : 'Message... (Enter to send, Shift+Enter for a new line)';
    }

    changeApiKeyBtn.addEventListener('click', () => {
      settingsPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'changeApiKey' });
    });
    openSettingsBtn.addEventListener('click', () => {
      settingsPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'openExtensionSettings' });
    });
    sendKeySegmented.addEventListener('click', (e) => {
      const btn = e.target.closest('.segmentedOption');
      if (!btn || btn.dataset.value === currentSendKey) return;
      vscode.postMessage({ type: 'setSendKey', value: btn.dataset.value });
    });
    focusModeSegmented.addEventListener('click', (e) => {
      const btn = e.target.closest('.segmentedOption');
      if (!btn) return;
      const wantsOn = btn.dataset.value === 'on';
      if (wantsOn === currentFocusMode) return;
      vscode.postMessage({ type: 'setFocusMode', value: wantsOn });
    });

    function renderUsageStats(dayTokens, monthCost) {
      usageStatsEl.textContent = 'Today: ' + (dayTokens || 0).toLocaleString() + ' tok  ·  Month: ' + formatCost(monthCost);
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

    function renderQueueNote() {
      queueNoteEl.textContent = messageQueue.length
        ? messageQueue.length + ' message' + (messageQueue.length > 1 ? 's' : '') + ' queued — sends once this reply finishes'
        : '';
    }

    // The actual turn-start — startTurn/postMessage — split out of send()
    // so a queued item can trigger it later via dispatchNextQueued()
    // without duplicating this.
    function dispatchTurn(text, attachments) {
      const turnId = Date.now() + '-' + Math.random().toString(36).slice(2);
      startTurn(turnId);
      setSending(true);
      vscode.postMessage({ type: 'send', text, attachments, turnId });
    }

    // Called from every turn-completion path (finalizeTurn, the error
    // handler) except Stop, which clears the queue instead — see
    // messageQueue's own comment.
    function dispatchNextQueued() {
      if (messageQueue.length === 0) { setSending(false); return; }
      const next = messageQueue.shift();
      renderQueueNote();
      dispatchTurn(next.text, next.attachments);
    }

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
      // Rendered immediately either way — queued or not, the message
      // landed the moment you hit send, same as any chat app. Only when
      // its reply actually starts is deferred.
      addMessage('user', displayContent);

      const attachments = pendingAttachments;
      pendingAttachments = [];
      renderChips();
      inputEl.value = '';
      autoGrow();

      if (activeTurn) {
        messageQueue.push({ text, attachments });
        renderQueueNote();
        return;
      }
      dispatchTurn(text, attachments);
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
        // An explicit Stop clears anything queued behind it too, rather
        // than auto-firing the next one — a cancel is "abandon this
        // direction," not "skip ahead to the next queued thing."
        messageQueue = [];
        renderQueueNote();
        setSending(false);
        return;
      }
      send();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // rizo.composer.sendKey: 'enter' (default) sends on plain Enter,
      // Shift+Enter for a newline. 'ctrlEnter' flips that — Enter alone
      // makes a newline, Ctrl/Cmd+Enter sends — for anyone who writes
      // multi-line prompts often enough that plain Enter sending is the
      // annoying default.
      const wantsSend = currentSendKey === 'ctrlEnter' ? e.ctrlKey || e.metaKey : !e.shiftKey;
      if (!wantsSend) return;
      e.preventDefault();
      send();
    });
    newThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
    renameThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'renameThread' }));
    deleteThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'deleteThread' }));
    threadSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'switchThread', id: threadSelect.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        renderThreadList(msg.threads, msg.activeThreadId);
        renderMessages(msg.messages);
        applyProviderState(msg.provider, msg.model, msg.effort);
        renderThreadStats(msg.threadTokens, msg.threadCost);
        renderUsageStats(msg.dayTokens, msg.monthCost);
        renderSettingsState(msg.sendKey, msg.focusMode);
        return;
      }
      if (msg.type === 'threadListUpdated') {
        renderThreadList(msg.threads, msg.activeThreadId);
        return;
      }
      if (msg.type === 'settingsUpdate') {
        // Deliberately not renderMessages()/applyProviderState() here —
        // see sendSettingsUpdate's comment. A settings change mid-turn
        // must never touch activeTurn or the message queue.
        renderSettingsState(msg.sendKey, msg.focusMode);
        return;
      }
      if (msg.type === 'attachmentAdded') {
        pendingAttachments.push(msg.attachment);
        renderChips();
        return;
      }
      if (msg.type === 'prefillComposer') {
        inputEl.value = msg.text;
        autoGrow();
        inputEl.focus();
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
        renderUsageStats(msg.dayTokens, msg.monthCost);
      } else if (msg.type === 'error') {
        activeTurn.el.remove();
        activeTurn = null;
        addMessage('assistant', 'Error: ' + msg.error);
        dispatchNextQueued();
      }
      // 'cancelled' needs no handling — the local Stop click already
      // finalized the UI; this is just the extension's confirmation.
    });

    renderProviderGrid();
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
