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
  startingModelForProvider,
  isValidProviderModel,
  findVariant,
  supportsReasoning,
  effortForTier,
} from './providers';
import { estimateStartingTier } from './complexityEstimator';
import { detectStruggle } from './struggleDetector';
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
  addThreadExtraRoots,
  sumThreadTokens,
  sumThreadCost,
} from './threadStore';

// Caps a runaway tool loop while leaving room for a normal multi-file
// task (read, edit, verify) to actually finish.
const MAX_TOOL_ITERATIONS = 30;

const SECRET_KEY = 'rizo.openRouterApiKey';
// Holds one thread — the most recently deleted, cleared once restored.
// Not a stack: only the last deletion is recoverable.
const LAST_DELETED_THREAD_KEY = 'rizo.lastDeletedThread';

// Cheapest available model — summarizing old history is internal
// housekeeping, not a user-facing reply, so it shouldn't use the
// thread's own (possibly expensive) model.
const SUMMARY_MODEL = PROVIDERS.openai.variants[0].id;

// Threads longer than this stop replaying full raw history — everything
// older than the last SUMMARY_KEEP_TAIL folds into a running summary.
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

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Extracts absolute paths the user's own message names and confirms
// exist on disk — a human-named path is trusted where a model-named one
// isn't (see Thread.extraRoots in threadStore.ts). Regex extraction is
// deliberately loose; fs.existsSync is the real filter, so anything
// path-shaped but not real (a version number, a date) just gets dropped.
function detectExtraRoots(text: string): string[] {
  const candidates = new Set<string>();
  for (const m of text.matchAll(/(['"])(\/[^'"]+)\1/g)) candidates.add(m[2]);
  for (const m of text.matchAll(/\/[^\s'"]+/g)) candidates.add(m[0].replace(/[.,;:!?)]+$/, ''));
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) found.push(fs.realpathSync(candidate));
    } catch {
      /* not a real path on this OS (too long, invalid characters, etc.) — skip it */
    }
  }
  return found;
}

// Merges the workspace's .gitignore into the file-picker's exclude
// pattern — VS Code's own findFiles exclude param doesn't consult
// .gitignore at all. Simple line-by-line glob conversion, not a full
// parser (no negation, no nested .gitignore) — enough to keep build
// output and vendored deps out of the picker.
function gitignoreExcludeGlobs(folder: vscode.Uri): string[] {
  try {
    const content = fs.readFileSync(path.join(folder.fsPath, '.gitignore'), 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      // A bare `**/dist` glob only matches something literally named
      // "dist", not anything inside it — but most .gitignore entries have
      // no trailing slash and match both files and dirs. Emitting both
      // forms per line covers both cases without statting the filesystem.
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
  // Set for one in-flight handleSend call; 'cancel' aborts the fetch via
  // the controller and records turnId so the tool loop (uninterruptible
  // mid-iteration) at least refuses to start the next one.
  private activeAbortController: AbortController | undefined;
  private cancelledTurnId: string | undefined;
  // Resolves once the webview sends 'ready' — a postMessage sent before
  // then (e.g. addFileToThread invoked before Rizo's first open) would
  // otherwise race past the listener and silently do nothing.
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Needed for webview.asWebviewUri() to serve assets/mascot.png —
        // without it, asWebviewUri can't resolve paths and the image
        // would need base64-inlining into the HTML instead.
        localResourceRoots: [vscode.Uri.file(context.extensionPath)],
      },
    );
    // Without this the tab shows plain text instead of an icon.
    panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'icon.png'));

    ChatPanel.currentPanel = new ChatPanel(panel, context);
  }

  // Always prompts, unlike getApiKey() (only prompts if nothing's
  // stored) — the explicit "change my key" path from the command
  // palette or Settings panel. A cancelled/empty prompt leaves the
  // stored key untouched.
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
      // Real VS Code settings, not workspaceState — editable from either
      // the in-webview panel or VS Code's own Settings UI, read live.
      sendKey: vscode.workspace.getConfiguration('rizo').get<string>('composer.sendKey', 'enter'),
      focusMode: vscode.workspace.getConfiguration('rizo').get<boolean>('view.focusMode', false),
    });
  }

  // Deliberately not sendInit() — that also re-renders the message list
  // and resets activeTurn/messageQueue, which drops an in-flight reply's
  // tracking if a setting changes mid-turn. Only touches these two
  // values, never messages/turn state.
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

  // Modal confirm first, then an Undo toast. If the deleted thread was
  // active, falls back to the next most-recently-updated thread, or a
  // new one if that was the last.
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
      // Bound to this exact thread via the closure, not the shared stash
      // — toasts can stack, so an older toast's Undo must still restore
      // its own thread even after a later delete overwrites
      // LAST_DELETED_THREAD_KEY.
      vscode.window.showInformationMessage(`Deleted "${thread.name}".`, 'Undo').then((choice) => {
        if (choice === 'Undo') this.restoreSpecificThread(thread);
      });
    }
  }

  // Shared by the Undo toast above (a specific thread) and
  // restoreLastDeleted below (whatever was most recently deleted).
  private async restoreSpecificThread(thread: ThreadData) {
    // Only clear the stash if it still holds this thread — a second
    // delete may have already overwritten it.
    if (this.context.globalState.get<ThreadData>(LAST_DELETED_THREAD_KEY)?.id === thread.id) {
      await this.context.globalState.update(LAST_DELETED_THREAD_KEY, undefined);
    }
    restoreThread(this.context, thread);
    this.activeThreadId = thread.id;
    // Avoids a redundant/out-of-order postMessage on a cold panel — see
    // addFileToThread's comment.
    await this.ready;
    this.sendInit();
  }

  // rizo.reopenClosedSession (extension.ts) lands here — restores
  // whatever was most recently deleted, last-one-wins. The Undo toast
  // bypasses this and restores its own specific thread (see
  // handleDeleteThread).
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

  // Free routes through a fallback chain (individual free models 429 or
  // return empty far more than paid ones); every other provider is a
  // direct call to the exact variant picked, no fallback. hasImage is
  // already validated against the variant's vision flag by the caller
  // (handleSend) before this runs.
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
      // Vision already checked in handleSend for every provider (Free
      // included, now that Gemma supports vision).
      const chain = freeChainForTaskType(taskType);
      // Auto is routed purely by taskType. A specific pick goes first,
      // then still falls through the rest of the chain if it's down or
      // rate-limited.
      const orderedChain = model === defaultModelForProvider('free') ? chain : [model, ...chain.filter((m) => m !== model)];
      return callWithFallback(apiKey, orderedChain, messages, tools, options);
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
  // composer and focuses it, but never sends automatically: one
  // accidental click would otherwise spend real tokens on the active
  // thread's paid model with zero review. Same prefill-then-Send
  // pattern "Mention file from this project..." already uses.
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

      // Reject anything that doesn't look like text rather than dumping
      // garbled bytes — a null byte in the first slice is the standard
      // cheap tell (same heuristic git uses).
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

  // Past SUMMARIZE_THRESHOLD messages, folds everything older than
  // SUMMARY_KEEP_TAIL into a running summary via one cheap-tier call —
  // only affects what's sent to the model, not what's stored/shown.
  // Fire-and-forget from handleSend, so a failure just means retry next
  // turn.
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
    // Captured once, used for every read/write this turn does — never
    // this.activeThreadId again. A turn can outlive the panel's active
    // thread (switched or deleted mid-reply); without this, the turn's
    // messages would save under whatever thread happens to be active
    // when it finishes.
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
    let model = thread.model;
    // A stored model id can go stale if an upstream provider pulls or
    // renames it — falls back to this provider's current default instead
    // of sending a request doomed to fail every time; setThreadModel
    // persists it so this only self-heals once per thread, not every turn.
    if (!isValidProviderModel(provider, model)) {
      const fallback = defaultModelForProvider(provider);
      setThreadModel(this.context, threadId, provider, fallback);
      model = fallback;
    }
    let effort: EffortLevel = (thread.effort as EffortLevel) || DEFAULT_EFFORT;

    try {
      // /commit, /review, /test expand to a canned prompt and force
      // 'coding' task type. An unrecognized "/foo" falls through as
      // literal text. taskType only decides which skill files load and
      // (Free provider) which fallback chain to try — not which model
      // answers.
      const slashExpansion = expandSlashCommand(text);
      const effectiveText = slashExpansion ?? text;

      // A real path this message names, outside every open workspace
      // folder, grants read_file/write_file/edit_file access to it for
      // this and every future turn in this thread — see detectExtraRoots.
      const newExtraRoots = detectExtraRoots(effectiveText);
      if (newExtraRoots.length > 0) addThreadExtraRoots(this.context, threadId, newExtraRoots);
      const extraRoots = [...new Set([...(thread.extraRoots || []), ...newExtraRoots])];

      const messageTaskType: TaskType = slashExpansion ? 'coding' : detectTaskType(effectiveText);
      // Sticky: a short follow-up ("yes", "continue") rarely has a coding
      // keyword, but a task that started coding-flavored doesn't stop being
      // one — see upgradeThreadTaskType in threadStore.ts.
      const taskType: TaskType = thread.taskType === 'coding' ? 'coding' : messageTaskType;
      if (messageTaskType === 'coding') upgradeThreadTaskType(this.context, threadId, 'coding');

      // Shared by both auto-suggestions below — a 0/1/2 read on how
      // demanding this message looks (coding-flavor, code blocks, stack
      // traces, attachments, length, "big ask" phrasing).
      const messageTier = estimateStartingTier(effectiveText, attachments.length > 0, taskType === 'coding');

      // Only on a thread's first message, and only if the model is still
      // at the picker's default (a manual pick always wins over a guess).
      // Skipped for Free — its 6 variants aren't a cheap-to-strong ladder
      // (providers.ts), so there's nothing for a tier to upgrade to.
      if (provider !== 'free' && thread.messages.length === 0 && model === defaultModelForProvider(provider)) {
        const smarterModel = startingModelForProvider(provider, messageTier);
        if (smarterModel !== model) {
          setThreadModel(this.context, threadId, provider, smarterModel);
          model = smarterModel;
        }
      }

      // Unlike the model pick, effort is per-request, not a thread trait —
      // re-evaluated every turn, never persisted (so it can't fight the
      // next turn's guess). Deferred permanently once the user sets effort
      // manually (thread.effortManuallySet).
      if (!thread.effortManuallySet && supportsReasoning(provider, model)) {
        effort = effortForTier(messageTier);
      }

      // Only coding-classified messages get skill instructions — general
      // chat doesn't need engineering-discipline guidance.
      const skillsDir = path.join(this.context.extensionPath, 'skills');
      const skillsContent = loadSkillsContent(skillsDir, effectiveText, taskType);

      // Without any system prompt, some models (DeepSeek in particular)
      // default to Chinese on short/ambiguous input — this instruction
      // always applies, regardless of task type.
      const systemParts = [
        'Always respond in English, even if the user writes in another language or the request is ambiguous.',
      ];
      if (skillsContent) systemParts.push(skillsContent);

      // The user's own .rizo/instructions.md, if present — unlike skills,
      // not gated to 'coding' since project intent can matter for any
      // reply. Silently absent if the file doesn't exist.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const projectInstructions = loadProjectInstructions(workspaceRoot);
      if (projectInstructions) {
        systemParts.push(
          `Project-specific instructions (from .rizo/instructions.md in this workspace):\n${projectInstructions}`,
        );
      }

      // Once folded by maybeSummarize, replays the summary plus only what's
      // newer — not the full raw history. Storage/UI still show everything;
      // this only shrinks what's sent to the model.
      if (thread?.summary) {
        systemParts.push(`Summary of earlier parts of this conversation (for background context, don't repeat it back):\n${thread.summary}`);
      }
      const summarizedCount = thread?.summarizedCount || 0;
      const tailMessages = (thread?.messages || []).slice(summarizedCount);
      const history: ChatMessage[] = tailMessages.map((m) => ({ role: m.role, content: m.content }));

      // Text attachments fold into the message text (no "file" part type in
      // this schema); images become image_url parts. Plain string content
      // when nothing's attached.
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

      // Vision is needed if this turn attached an image, or history carries
      // one from earlier (a follow-up needs the model to still see it).
      const hasImage = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
      );
      if (hasImage) {
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
      // Kept short and explicit — this string gets persisted and replayed
      // as this turn's reply in every future turn's history, so a vague
      // placeholder would misinform later turns.
      let finalReply = "I ran out of steps before finishing (hit the tool-call limit for one turn) — say 'continue' and I'll pick back up.";
      const totalUsage = emptyUsage();

      // Struggle evidence for auto-escalation below — three cheap,
      // deterministic signals, no extra model call:
      //   - completedNormally: false only if the loop hits the iteration
      //     cap without a tool-call-free reply.
      //   - maxConsecutiveToolErrors: the model gives up and answers anyway
      //     after repeatedly hitting the same broken approach.
      //   - madeToolCallThisTurn/madeMutatingCallThisTurn: feed a
      //     cross-turn check (below) — a turn that only reads looks fine
      //     alone, but re-checking the same broken file turn after turn,
      //     never fixing it, is what neither single-turn signal catches.
      let completedNormally = false;
      let consecutiveToolErrors = 0;
      let maxConsecutiveToolErrors = 0;
      let madeToolCallThisTurn = false;
      let madeMutatingCallThisTurn = false;
      // Deduplicated per turn; converted to an array at persist time.
      const touchedFilesThisTurn = new Set<string>();

      // Sent after Smart Starting Variant resolves model, so the bubble
      // never shows a value that turns out wrong.
      this.panel.webview.postMessage({ type: 'turnModel', turnId, model });

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (this.cancelledTurnId === turnId) break;

        const { model: usedModel, message, usage, finishReason } = await this.callModel(apiKey, provider, model, taskType, messages, hasImage, enabledTools, {
          signal: controller.signal,
          // Dropped for a variant that doesn't support it rather than sent
          // and possibly rejected; callWithFallback never forwards it
          // regardless.
          reasoningEffort: supportsReasoning(provider, model) ? effort : undefined,
          onDelta: (chunk) => this.panel.webview.postMessage({ type: 'textDelta', turnId, text: chunk }),
          // Clears partial streamed text before the next model's attempt,
          // so the two don't visually run together.
          onRestart: () => this.panel.webview.postMessage({ type: 'textReset', turnId }),
        });
        answeredBy = usedModel;
        totalUsage.promptTokens += usage.promptTokens;
        totalUsage.completionTokens += usage.completionTokens;
        totalUsage.totalTokens += usage.totalTokens;
        // Running total — a multi-tool-call turn makes several round-trips.
        this.panel.webview.postMessage({ type: 'turnUsage', turnId, totalTokens: totalUsage.totalTokens });

        if (!message.tool_calls || message.tool_calls.length === 0) {
          finalReply = message.content || '';
          completedNormally = true;
          break;
        }

        // Record the assistant's tool-call turn before executing anything,
        // so history stays valid even if a tool call throws.
        messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls });

        // Cancellation only stops the next call from starting — a call
        // already in flight still runs to completion.
        for (const toolCall of message.tool_calls) {
          if (this.cancelledTurnId === turnId) break;
          madeToolCallThisTurn = true;
          if (toolCall.function.name === 'write_file' || toolCall.function.name === 'edit_file') {
            madeMutatingCallThisTurn = true;
          }
          const summary = summarizeToolCall(toolCall.function.name, toolCall.function.arguments, extraRoots);
          // summary.title is already the extracted (or best-effort
          // recovered) path for these three tools — reusing it here
          // instead of re-parsing toolCall.function.arguments ourselves.
          if (
            (toolCall.function.name === 'read_file' || toolCall.function.name === 'write_file' || toolCall.function.name === 'edit_file') &&
            summary.title &&
            summary.title !== '(unknown path)'
          ) {
            touchedFilesThisTurn.add(summary.title);
          }
          this.panel.webview.postMessage({
            type: 'toolStart',
            turnId,
            callId: toolCall.id,
            label: summary.label,
            title: summary.title,
            detail: summary.detail,
            diffOld: summary.diffOld,
            diffNew: summary.diffNew,
            isNewFile: summary.isNewFile,
          });
          // A cut-off response (finish_reason 'length') whose last tool
          // call fails to parse isn't a formatting mistake — it's too big
          // for one call. Skips the generic parse error and gives guidance
          // the model can act on.
          const isLastCall = toolCall === message.tool_calls[message.tool_calls.length - 1];
          const looksTruncated =
            finishReason === 'length' &&
            isLastCall &&
            (toolCall.function.name === 'write_file' || toolCall.function.name === 'edit_file') &&
            !isParseableJson(toolCall.function.arguments);
          const result = looksTruncated
            ? `Error: this ${toolCall.function.name} call was cut off before finishing — it hit the response size limit partway through the content, not a formatting mistake. The file is too large for one call. Split it: call ${toolCall.function.name} now with a smaller amount of content (e.g. a skeleton, or just the first section), then use edit_file in a follow-up call to add the rest in pieces.`
            : await executeTool(this.context, toolCall.function.name, toolCall.function.arguments, extraRoots, threadId);
          const toolOk = !result.startsWith('Error:');
          this.panel.webview.postMessage({
            type: 'toolEnd',
            turnId,
            callId: toolCall.id,
            ok: toolOk,
            resultDetail: summarizeToolResult(result),
          });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
          consecutiveToolErrors = toolOk ? 0 : consecutiveToolErrors + 1;
          maxConsecutiveToolErrors = Math.max(maxConsecutiveToolErrors, consecutiveToolErrors);
        }
      }

      const elapsedMs = Date.now() - startedAt;

      // previousAssistantMsg reads thread.messages before this turn's own
      // exchange is appended below, so it's genuinely the prior turn.
      // Offered only when a stronger variant exists in this provider
      // (company-locked) — Free and an already-top-tier turn never show a
      // dead button.
      const previousAssistantMsg = [...(thread?.messages || [])].reverse().find((m) => m.role === 'assistant');
      const struggled = detectStruggle({
        wasCancelled: this.cancelledTurnId === turnId,
        completedNormally,
        maxConsecutiveToolErrors,
        current: { madeToolCall: madeToolCallThisTurn, madeMutatingCall: madeMutatingCallThisTurn },
        previous: previousAssistantMsg
          ? { madeToolCall: !!previousAssistantMsg.madeToolCall, madeMutatingCall: !!previousAssistantMsg.madeMutatingCall }
          : undefined,
      });
      let escalationModel: string | undefined;
      let escalationLabel: string | undefined;
      if (struggled && provider !== 'free') {
        const variants = PROVIDERS[provider]?.variants || [];
        const top = variants[variants.length - 1];
        if (top && top.id !== model) {
          escalationModel = top.id;
          escalationLabel = top.label;
        }
      }

      // Folds this turn's cost into the running today/this-month totals
      // the header shows.
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
          madeToolCall: madeToolCallThisTurn,
          madeMutatingCall: madeMutatingCallThisTurn,
          ...(touchedFilesThisTurn.size > 0 ? { touchedFiles: [...touchedFilesThisTurn] } : {}),
        },
      ];
      saveThreadMessages(this.context, threadId, updated);

      // Auto-name the thread from its first message, only when it's still
      // the default name — never overrides a Rename.
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
        // Distinct from answeredBy (this turn's own tag) — the thread's
        // current model, possibly upgraded by Smart Starting Variant above.
        // Lets the pill catch up without a full re-render.
        currentModel: model,
        // Same idea for effort — this turn's guess or the user's manual
        // pick, never threadStore (auto-suggestion never writes there).
        currentEffort: effort,
        taskType,
        reply: finalReply,
        escalationModel,
        escalationLabel,
        usage: totalUsage,
        elapsedMs,
        threadTokens: sumThreadTokens(updated),
        threadCost: sumThreadCost(updated),
        dayTokens: globalUsage.dayTokens,
        monthCost: globalUsage.monthCost,
      });

      // Fire-and-forget — never makes the user wait on housekeeping.
      void this.maybeSummarize(apiKey, threadId);
    } catch (err: any) {
      // Stop was clicked — the webview already shows "Stopped." locally;
      // this confirms the extension side unwound. Deliberately not
      // persisted — an aborted turn isn't a failure the next turn needs a
      // history record of.
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

  // Persists a failed turn so the next turn's context isn't missing "you
  // asked X, it failed". No-ops if userContent is undefined (error
  // happened before the message was built).
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
    // asWebviewUri, not a base64 data: URI — inlining a 444KB image as
    // base64 text into the HTML string on every render is exactly what
    // VS Code's webview guide warns against.
    const mascotPath = path.join(this.context.extensionPath, 'assets', 'mascot.png');
    const mascotUri = this.panel.webview.asWebviewUri(vscode.Uri.file(mascotPath));
    // Trimmed view of providers.ts handed to the webview once, so the
    // picker grid renders from the same catalog isValidProviderModel
    // enforces — no risk of drift.
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${this.panel.webview.cspSource} data:; script-src 'nonce-${nonce}';">
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
    /* Without this, buttons that don't fit are pushed fully off the
       right edge and become unreachable rather than visible on a second
       line — a real bug, not hypothetical: on a normal-width sidebar
       panel the Settings gear (last child) rendered completely outside
       the viewport, with no scrollbar or any other way to reach it.
       Caught by actually rendering this at panel width, not by reading
       the flexbox rule and assuming it'd be fine. */
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-widget-border);
    align-items: center;
  }
  /* A <select> resists shrinking below its content's width even with
     min-width: 0 / width: 0 set directly on it — confirmed empirically
     (a plain flex item shrinks fine; the native form control specifically
     doesn't, in Chrome/the Electron renderer VS Code webviews use). The
     fix is this wrapper: a plain div negotiates the flex-shrink instead,
     then the select just fills width:100% of whatever room that div
     ends up with, never negotiating its own intrinsic size at all. */
  #threadSelectWrap { flex: 1; min-width: 0; }
  #threadSelect {
    width: 100%;
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

  /* Model pill — shows "<Provider> · <Variant>" for the thread's locked
     provider and opens a dropdown of only that provider's own variants.
     No control here can switch to a different company — that's a
     one-time choice made in #providerPicker. */
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

  /* Overflow menu — the one "&#8942;" button in threadBar, same
     dropdown-shell pattern as the model/effort pills above
     (absolute-positioned panel, not a modal). Rename/Delete/Settings all
     live here now instead of each being its own always-visible button —
     threadBar overflowed on a normal-width sidebar panel otherwise (the
     select's native minimum width alone can eat the room three-plus
     fixed-width buttons need, min-width:0 and flex-wrap notwithstanding
     — confirmed by actually rendering it narrow, not by reasoning about
     flexbox in the abstract). New chat stays its own button since it's
     the one action used often enough to deserve one click, not two. */
  #menuWrap { position: relative; }
  #menuPanel {
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
  #menuPanel.open { display: block; }
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
  /* Delete is the one item in this menu that discards data (beyond the
     modal confirm it shows), so it keeps its own warning color instead
     of blending into Rename/everything else. */
  .dangerBtn:hover { background: rgba(241, 76, 76, 0.15); color: var(--vscode-errorForeground, #f14c4c); }
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
     ease-out — no slide/scale. */
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes pulseThinking { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes blinkCursor { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .msg, .toolCard { animation: none; }
    .thinkingDot, .streamCursor { animation: none; opacity: 0.6; }
  }

  /* --- Messages --- */
  #messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  /* Full-width transcript rows, not chat bubbles — a user turn is a
     left-accented block, an assistant turn is plain text under a thin
     top divider. Reads as a running log, not a two-column conversation. */
  .msg { max-width: 100%; padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; animation: .18s ease-out fadeIn; }
  .msg.user { align-self: stretch; background: rgba(128,128,128,0.06); border-left: 2px solid var(--vscode-button-background); }
  .msg.assistant { align-self: stretch; background: transparent; border: none; border-top: 1px solid var(--vscode-widget-border); padding: 12px 10px 8px; }
  .msg .attachedImg { max-width: 220px; max-height: 220px; border-radius: 8px; display: block; margin-top: 6px; }

  /* --- Live tool-call transcript --- */
  .transcript { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  /* Focus view (rizo.view.focusMode) — hides tool-call activity, leaving
     only prompts and final answers. Live tool cards are still created
     normally underneath; this is purely visual, so turning it off mid-turn
     doesn't lose anything. */
  body.focusMode .transcript { display: none; }

  /* Two-tier tool card: a single-line header (tag + human-readable intent)
     always visible, with the exact command/args and result folded away
     behind a click. Collapsed by default: a turn can run up to 30 tool
     calls, and showing every raw command/result inline would read as a
     wall of text. */
  .toolCard {
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border);
    background: rgba(128,128,128,0.08);
    animation: .15s ease-out fadeIn;
    overflow: hidden;
  }
  .toolCard.failed { border-color: var(--vscode-errorForeground, #f14c4c); }
  .toolHeader {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .toolHeader:hover { background: rgba(128,128,128,0.1); }
  .toolStatus { flex-shrink: 0; width: 10px; text-align: center; font-size: 11.5px; }
  .toolCard.running .toolStatus { opacity: 0.75; }
  .toolCard.running .toolStatus::after { content: '…'; }
  .toolCard.failed .toolStatus { color: var(--vscode-errorForeground, #f14c4c); }
  .toolLabel {
    flex-shrink: 0;
    font-size: 10.5px;
    font-weight: 600;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-textLink-foreground);
    opacity: 0.85;
  }
  .toolTitle {
    flex: 1;
    font-size: 11.5px;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .toolCard.failed .toolTitle { color: var(--vscode-errorForeground, #f14c4c); }
  .toolChevron {
    flex-shrink: 0;
    font-size: 9px;
    opacity: 0.5;
    transition: transform .12s ease;
  }
  .toolCard.expanded .toolChevron { transform: rotate(90deg); }
  .toolBody {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 8px 8px 24px;
  }
  /* An author-origin display rule beats the UA stylesheet's own
     [hidden]{display:none} regardless of source order or specificity —
     without this, .toolBody's own display: flex above silently wins and
     the body renders every card pre-expanded no matter what JS sets
     .hidden to. Caught by actually screenshotting the collapsed state
     rather than trusting "it compiles." No backticks in this comment —
     this whole block lives inside getHtml()'s own outer TS template
     literal, and one would silently truncate it. */
  .toolBody[hidden] { display: none; }
  .toolBodyBlock { display: flex; flex-direction: column; gap: 2px; }
  .toolBodyTag {
    font-size: 9.5px;
    font-weight: 600;
    font-family: var(--vscode-editor-font-family);
    letter-spacing: 0.04em;
    opacity: 0.55;
  }
  /* Fixed terminal colors, not a theme variable — command/file output
     reads as a terminal specifically because it's NOT theme-blended the
     way the rest of the panel is. A theme variable here would tint
     toward the ambient editor background, producing a pale, low-contrast
     box in a light theme instead of an actual terminal. */
  .toolBodyBlock pre {
    margin: 0;
    padding: 8px 10px;
    border-radius: 5px;
    background: #0c0c0c;
    color: #e8e8e8;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
  }
  /* Real +/- line diff for Edit/Write tool cards (see buildDiffView) —
     same insert/remove theme tokens the native VS Code diff editor uses,
     so it matches whatever diff colors the user's theme already defines
     instead of a fixed guess. */
  .diffBlock {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    border-radius: 5px;
    max-height: 320px;
    overflow: auto;
  }
  .diffBlock pre { margin: 0; padding: 8px 10px; }
  .diffLine { display: flex; gap: 8px; padding: 0 8px; white-space: pre; }
  .diffMarker { flex-shrink: 0; width: 10px; opacity: 0.7; user-select: none; }
  .diffCtx { opacity: 0.75; }
  .diffAdd { background: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.15)); }
  .diffAdd .diffMarker { color: #4ec9b0; }
  .diffDel { background: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.15)); }
  .diffDel .diffMarker { color: #f14c4c; }

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

  /* Live-only status line on a pending turn — model, current action,
     elapsed time, running tokens. Plain text rather than a badge like
     .model-tag above: it changes several times a second while a turn is
     in flight, and a pill redrawing that often reads as more distracting
     than a quiet text line does. */
  .turnStatus {
    display: block;
    font-size: 11px;
    opacity: 0.6;
    margin-bottom: 6px;
    font-variant-numeric: tabular-nums;
  }

  .retryEscalateBtn {
    margin-top: 8px;
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--vscode-button-background);
    background: transparent;
    color: var(--vscode-button-background);
    cursor: pointer;
  }
  .retryEscalateBtn:hover:not(:disabled) {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .retryEscalateBtn:disabled { opacity: 0.6; cursor: default; }

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
    <div id="threadSelectWrap"><select id="threadSelect"></select></div>
    <button class="iconBtn" id="newThreadBtn">New</button>
    <div id="menuWrap">
      <button class="iconBtn" id="menuBtn" title="Rename, delete, settings">&#8942;</button>
      <div id="menuPanel">
        <button class="settingsBtn" id="renameThreadBtn">Rename this chat</button>
        <button class="settingsBtn dangerBtn" id="deleteThreadBtn">Delete this chat</button>
        <div class="settingsDivider"></div>
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
          <div class="settingsLabel" title="Hides the tool-call transcript, showing only your prompts and the final answers">Focus view</div>
          <div class="segmented" id="focusModeSegmented">
            <button class="segmentedOption" data-value="off">Off</button>
            <button class="segmentedOption" data-value="on">On</button>
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
    <img src="${mascotUri}" alt="">
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
    const menuBtn = document.getElementById('menuBtn');
    const menuPanelEl = document.getElementById('menuPanel');
    const changeApiKeyBtn = document.getElementById('changeApiKeyBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const sendKeySegmented = document.getElementById('sendKeySegmented');
    const focusModeSegmented = document.getElementById('focusModeSegmented');
    // Mirrors rizo.composer.sendKey / rizo.view.focusMode (real VS Code
    // settings, see sendInit) — editable from Settings UI too.
    let currentSendKey = 'enter';
    let currentFocusMode = false;
    const EFFORT_LEVELS = [
      { id: 'low', label: 'Low', tagline: 'Fast, cheapest — trivial follow-ups' },
      { id: 'medium', label: 'Medium', tagline: 'Balanced — the default' },
      { id: 'high', label: 'High', tagline: 'Slower, priciest — hard problems' },
    ];
    // Current provider/model/effort for this thread — null/default until
    // the picker's used once. Gates sending and populates the switchers.
    let currentProvider = null;
    let currentModel = null;
    let currentEffort = 'medium';
    // Messages typed while a turn runs — send() pushes here instead of
    // dispatching immediately. dispatchNextQueued() drains one per
    // completion. Cleared (not drained) on Stop — cancel means abandon,
    // not skip ahead. Cleared on thread switch too.
    let messageQueue = [];
    // The in-flight turn's live state — null when nothing's running. Every
    // extension->webview message carries a turn id; anything not matching
    // activeTurn.id is dropped, which is what makes Stop safe without the
    // extension guaranteeing instant termination.
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

    // Hand-rolled, dependency-free markdown subset — code blocks, inline
    // code, bold/italic, lists, headers (flattened to bold; a real <h1>
    // reads oversized in a chat bubble). No link/image syntax — avoids an
    // injection vector. Escaping happens first, and code spans are
    // placeholder-protected so emphasis regexes never fire inside them —
    // what stands between this and XSS in model output.
    function renderMarkdown(raw) {
      let text = escapeHtml(raw);

      // No backslash-escape sequences below (newline, digit, whitespace,
      // word-char shorthand, escaped asterisk) — this script sits inside
      // an outer TS template literal, which processes backslash escapes
      // in its own pass before this code ever reaches a JS engine,
      // silently corrupting them. Character classes ([*], [0-9], [^]) and
      // fromCharCode for newline sidestep that entirely.
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

    // The one bubble a turn lives in for its whole lifecycle — same DOM
    // node throughout, never removed-and-replaced.
    // The 3-dot pulse for "Thinking…" — markup for CSS's .thinkingDot
    // animation.
    const THINKING_HTML = '<span class="thinkingDots"><span class="thinkingDot"></span><span class="thinkingDot"></span><span class="thinkingDot"></span></span>';

    // "Kimi K2 · Running write_file… · 14s · 3,420 tok". model arrives
    // once via 'turnModel'; tokens tick up via 'turnUsage'; elapsed runs
    // off a client-side timer.
    function renderTurnStatus(turn) {
      const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(0) + 's';
      const parts = [];
      if (turn.turnModel) {
        const p = findProvider(currentProvider);
        const variant = p && p.variants.find((v) => v.id === turn.turnModel);
        parts.push(variant ? p.label + ' · ' + variant.label : turn.turnModel);
      }
      parts.push(turn.currentAction);
      parts.push(elapsed);
      if (turn.liveTokens) parts.push(turn.liveTokens.toLocaleString() + ' tok');
      turn.statusEl.textContent = parts.join('  ·  ');
    }

    function startTurn(turnId) {
      const el = document.createElement('div');
      el.className = 'msg assistant pending';
      const statusEl = document.createElement('div');
      statusEl.className = 'turnStatus';
      const transcriptEl = document.createElement('div');
      transcriptEl.className = 'transcript';
      const textEl = document.createElement('span');
      textEl.className = 'streamedText';
      textEl.innerHTML = THINKING_HTML;
      el.appendChild(statusEl);
      el.appendChild(transcriptEl);
      el.appendChild(textEl);
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // bufferEl holds streamed text, created lazily on first delta — kept
      // separate from .streamCursor so new text never clobbers the cursor
      // node.
      activeTurn = {
        id: turnId, el, transcriptEl, textEl, bufferEl: null, toolLines: new Map(), textBuffer: '', hasText: false,
        statusEl, startedAt: Date.now(), turnModel: null, liveTokens: 0, currentAction: 'Thinking…',
      };
      renderTurnStatus(activeTurn);
      // Elapsed needs a live tick even when nothing else changes — a fresh
      // render every second is cheap.
      activeTurn.statusTimer = setInterval(() => renderTurnStatus(activeTurn), 1000);
      return activeTurn;
    }

    // Every path that stops a turn — finish, Stop, error, switching away —
    // must go through this, or statusTimer keeps ticking against a
    // detached turn.
    function stopTurnStatusTimer(turn) {
      if (turn && turn.statusTimer) clearInterval(turn.statusTimer);
    }

    // Classic LCS line diff. old/new are capped by DIFF_MAX_CHARS, but a
    // char cap can still hide a huge line count (20000 blank lines =
    // 20000 chars) — the DP table is O(n*m) in lines. buildDiffView's
    // a.length*b.length guard is the real backstop.
    function diffLines(oldText, newText) {
      const a = oldText.split('\\n');
      const b = newText.split('\\n');
      const n = a.length, m = b.length;
      const dp = [];
      for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const ops = [];
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
        else { ops.push({ type: 'add', text: b[j] }); j++; }
      }
      while (i < n) { ops.push({ type: 'del', text: a[i] }); i++; }
      while (j < m) { ops.push({ type: 'add', text: b[j] }); j++; }
      return ops;
    }

    function diffLine(type, text) {
      const line = document.createElement('div');
      line.className = 'diffLine diff' + (type === 'add' ? 'Add' : type === 'del' ? 'Del' : 'Ctx');
      const marker = document.createElement('span');
      marker.className = 'diffMarker';
      marker.textContent = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
      const text_ = document.createElement('span');
      text_.className = 'diffText';
      text_.textContent = text;
      line.appendChild(marker);
      line.appendChild(text_);
      return line;
    }

    // diffOld undefined/empty means "new file" (write_file with nothing
    // to diff against) — every line renders as added, no LCS needed.
    function buildDiffView(oldText, newText) {
      const wrap = document.createElement('div');
      wrap.className = 'diffBlock';
      if (!oldText) {
        newText.split('\\n').forEach((t) => wrap.appendChild(diffLine('add', t)));
        return wrap;
      }
      const a = oldText.split('\\n');
      const b = newText.split('\\n');
      if (a.length * b.length > 250000) {
        // Too large to line-diff cheaply — falls back to plain before/after
        // text rather than either freezing on the DP table or silently
        // showing nothing.
        const pre = document.createElement('pre');
        pre.textContent = '--- before ---\\n' + oldText + '\\n--- after ---\\n' + newText;
        wrap.appendChild(pre);
        return wrap;
      }
      for (const op of diffLines(oldText, newText)) wrap.appendChild(diffLine(op.type, op.text));
      return wrap;
    }

    // Builds one tool-call's two-tier card. bodyEl only gets an IN block
    // now (if this call has detail — read/write/edit have none, the path
    // in the title already says it all); handleToolEnd appends the OUT
    // block once the result's back. Starts collapsed; the header is a
    // <button> so it's keyboard-toggleable too, not just a click target.
    function handleToolStart(turnId, callId, label, title, detail, diffOld, diffNew, isNewFile) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      // A write/edit's diff opens automatically — the one thing worth
      // reading shouldn't need an extra click. Reads/commands stay
      // collapsed.
      const hasDiff = diffNew !== undefined;
      const card = document.createElement('div');
      card.className = hasDiff ? 'toolCard running expanded' : 'toolCard running';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'toolHeader';
      header.innerHTML =
        '<span class="toolStatus"></span>' +
        '<span class="toolLabel"></span>' +
        '<span class="toolTitle"></span>' +
        '<span class="toolChevron">▸</span>';
      header.querySelector('.toolLabel').textContent = label;
      header.querySelector('.toolTitle').textContent = title;

      const body = document.createElement('div');
      body.className = 'toolBody';
      body.hidden = !hasDiff;
      // Edit/write calls under DIFF_MAX_CHARS (tools.ts) get a real +/-
      // diff here instead of flat IN text — the native vscode.diff view at
      // approval time is gone by the time anyone scrolls back.
      if (hasDiff) {
        const block = document.createElement('div');
        block.className = 'toolBodyBlock';
        const tag = document.createElement('span');
        tag.className = 'toolBodyTag';
        tag.textContent = isNewFile ? 'NEW FILE' : 'DIFF';
        block.appendChild(tag);
        block.appendChild(buildDiffView(diffOld, diffNew));
        body.appendChild(block);
      } else if (detail) {
        const block = document.createElement('div');
        block.className = 'toolBodyBlock';
        const tag = document.createElement('span');
        tag.className = 'toolBodyTag';
        tag.textContent = 'IN';
        const pre = document.createElement('pre');
        pre.textContent = detail;
        block.appendChild(tag);
        block.appendChild(pre);
        body.appendChild(block);
      }

      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
        body.hidden = !card.classList.contains('expanded');
      });

      card.appendChild(header);
      card.appendChild(body);
      activeTurn.transcriptEl.appendChild(card);
      activeTurn.toolLines.set(callId, { card, body });
      // Surfaces "what's it doing right now" at a glance, without opening
      // a card.
      activeTurn.currentAction = title || label;
      renderTurnStatus(activeTurn);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleToolEnd(turnId, callId, ok, resultDetail) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const entry = activeTurn.toolLines.get(callId);
      if (!entry) return;
      entry.card.classList.remove('running');
      if (!ok) entry.card.classList.add('failed');

      if (resultDetail) {
        const block = document.createElement('div');
        block.className = 'toolBodyBlock';
        const tag = document.createElement('span');
        tag.className = 'toolBodyTag';
        tag.textContent = 'OUT';
        const pre = document.createElement('pre');
        pre.textContent = resultDetail;
        block.appendChild(tag);
        block.appendChild(pre);
        entry.body.appendChild(block);
      }
      // Back to a generic status until the next tool call or text stream
      // starts.
      activeTurn.currentAction = 'Thinking…';
      renderTurnStatus(activeTurn);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleTextDelta(turnId, text) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      if (!activeTurn.hasText) {
        activeTurn.textBuffer = '';
        activeTurn.hasText = true;
        // First real token — swap thinking-dots for the streamed-content
        // span plus a blinking cursor.
        activeTurn.textEl.innerHTML = '<span class="streamedContent"></span><span class="streamCursor"></span>';
        activeTurn.bufferEl = activeTurn.textEl.querySelector('.streamedContent');
        activeTurn.currentAction = 'Writing reply…';
        renderTurnStatus(activeTurn);
      }
      activeTurn.textBuffer += text;
      activeTurn.bufferEl.textContent = activeTurn.textBuffer;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Clears partial streamed text before the next fallback model's
    // attempt, so the two don't visually run together.
    function handleTextReset(turnId) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      activeTurn.textBuffer = '';
      activeTurn.hasText = false;
      activeTurn.bufferEl = null;
      activeTurn.textEl.innerHTML = THINKING_HTML;
      activeTurn.currentAction = 'Thinking…';
      renderTurnStatus(activeTurn);
    }

    // Swaps streamed text for rendered markdown once, using the server's
    // final string rather than the client's concatenated deltas — a
    // dropped/reordered delta can't cause drift.
    function finalizeTurn(turnId, replyText, model, taskType, usage, elapsedMs, escalationModel, escalationLabel) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const turn = activeTurn;
      turn.el.classList.remove('pending');
      // The live status line's job ends here — formatTag below covers the
      // same ground permanently. Removed before model-tag insertion so
      // turn.el.firstChild is back to transcriptEl.
      stopTurnStatusTimer(turn);
      turn.statusEl.remove();
      if (model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = formatTag(model, taskType, usage, elapsedMs);
        const br = document.createElement('br');
        turn.el.insertBefore(br, turn.el.firstChild);
        turn.el.insertBefore(tag, br);
      }
      turn.textEl.innerHTML = renderMarkdown(replyText || '');
      // Live-only affordance — not part of the persisted transcript. One
      // click re-locks the thread via the same 'selectModel' path the
      // switcher uses, then resends.
      if (escalationModel && escalationLabel) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'retryEscalateBtn';
        retryBtn.textContent = '↑ Retry with ' + escalationLabel;
        retryBtn.addEventListener('click', () => {
          retryBtn.disabled = true;
          retryBtn.textContent = 'Retrying with ' + escalationLabel + '…';
          vscode.postMessage({ type: 'selectModel', model: escalationModel });
          const retryText = 'Please try that again with more capability — take another look and finish it properly.';
          addMessage('user', retryText);
          if (activeTurn) {
            messageQueue.push({ text: retryText, attachments: [] });
            renderQueueNote();
          } else {
            dispatchTurn(retryText, []);
          }
        });
        turn.el.appendChild(document.createElement('br'));
        turn.el.appendChild(retryBtn);
      }
      activeTurn = null;
      dispatchNextQueued();
    }

    // content is a plain string or an array of parts ({type:'text'} /
    // {type:'image_url'}) — same shape as stored messages, so history
    // replay and a just-sent message render identically.
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
      // Only called on a context switch, never mid-reply — safe to drop
      // the prior view's turn rather than leave Stop stuck. Queue is
      // thread-scoped too.
      stopTurnStatusTimer(activeTurn);
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

    // Rebuilds the switcher for this thread's locked provider — reads only
    // that provider's variants, never the full catalog, so no code path
    // can render a different company's models.
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

    // Hidden entirely (not disabled) when the variant's reasoning flag is
    // false — Effort has no server-side effect there, so showing a dead
    // control would be worse than not showing it.
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

    // Single entry point for thread provider/model/effort state — keeps
    // the picker, pills, dropdowns, and composer in sync.
    function applyProviderState(provider, model, effort) {
      currentProvider = provider || null;
      currentModel = model || null;
      currentEffort = effort || 'medium';
      providerPickerEl.classList.toggle('visible', !currentProvider);
      // renderMessages() already set emptyState/messages visibility from
      // message count — override only for "no provider yet", so the
      // picker doesn't compete with the empty-state hint.
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
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.remove('open');
      menuPanelEl.classList.toggle('open');
    });
    menuPanelEl.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.remove('open');
      menuPanelEl.classList.remove('open');
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
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'changeApiKey' });
    });
    openSettingsBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
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

    // Cmd/Ctrl+V with an image on the clipboard attaches it the same way
    // "Attach file..." does. 5MB cap mirrors readAndSendAttachment's limit
    // on the extension side.
    const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024;
    inputEl.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        if (file.size > MAX_PASTED_IMAGE_BYTES) {
          addMessage('assistant', 'That pasted image is over the 5MB limit — try a smaller one.');
          continue;
        }
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const comma = dataUrl.indexOf(',');
          pendingAttachments.push({
            name: 'Pasted image',
            type: 'image',
            mimeType: file.type,
            content: dataUrl.slice(comma + 1),
          });
          renderChips();
        };
        reader.readAsDataURL(file);
      }
    });

    function renderQueueNote() {
      queueNoteEl.textContent = messageQueue.length
        ? messageQueue.length + ' message' + (messageQueue.length > 1 ? 's' : '') + ' queued — sends once this reply finishes'
        : '';
    }

    // Split out of send() so a queued item can trigger it later via
    // dispatchNextQueued() without duplicating this.
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
      // Rendered immediately either way — the message landed the moment
      // you hit send; only its reply is deferred.
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

    // sendBtn does double duty: Send when idle, Stop mid-turn (see
    // setSending). Stop finalizes the UI immediately rather than waiting
    // for the extension's 'cancelled' ack — turnId-gating below makes
    // that safe against in-flight messages arriving after.
    sendBtn.addEventListener('click', () => {
      if (activeTurn) {
        const turn = activeTurn;
        vscode.postMessage({ type: 'cancel', turnId: turn.id });
        stopTurnStatusTimer(turn);
        turn.statusEl.remove();
        const stoppedEl = document.createElement('div');
        stoppedEl.className = 'stoppedNote';
        stoppedEl.textContent = 'Stopped.';
        turn.el.appendChild(stoppedEl);
        turn.el.classList.remove('pending');
        activeTurn = null;
        // Stop clears anything queued too — cancel means abandon, not
        // skip ahead.
        messageQueue = [];
        renderQueueNote();
        setSending(false);
        return;
      }
      send();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // rizo.composer.sendKey: 'enter' sends on plain Enter, Shift+Enter
      // for a newline. 'ctrlEnter' flips that, for multi-line prompt
      // writers.
      const wantsSend = currentSendKey === 'ctrlEnter' ? e.ctrlKey || e.metaKey : !e.shiftKey;
      if (!wantsSend) return;
      e.preventDefault();
      send();
    });
    newThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
    renameThreadBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'renameThread' });
    });
    deleteThreadBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'deleteThread' });
    });
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
      // not (or no longer) the active one.
      if (!activeTurn || msg.turnId !== activeTurn.id) return;

      if (msg.type === 'toolStart') {
        handleToolStart(msg.turnId, msg.callId, msg.label, msg.title, msg.detail, msg.diffOld, msg.diffNew, msg.isNewFile);
      } else if (msg.type === 'toolEnd') {
        handleToolEnd(msg.turnId, msg.callId, msg.ok, msg.resultDetail);
      } else if (msg.type === 'textDelta') {
        handleTextDelta(msg.turnId, msg.text);
      } else if (msg.type === 'textReset') {
        handleTextReset(msg.turnId);
      } else if (msg.type === 'reply') {
        finalizeTurn(msg.turnId, msg.reply, msg.model, msg.taskType, msg.usage, msg.elapsedMs, msg.escalationModel, msg.escalationLabel);
        renderThreadStats(msg.threadTokens, msg.threadCost);
        renderUsageStats(msg.dayTokens, msg.monthCost);
        // Catches the pills up if model/effort silently changed (Smart
        // Starting Variant, effort auto-suggestion) — otherwise they'd
        // show a stale value until the next full re-render.
        const modelChanged = msg.currentModel && msg.currentModel !== currentModel;
        const effortChanged = msg.currentEffort && msg.currentEffort !== currentEffort;
        if (modelChanged) currentModel = msg.currentModel;
        if (effortChanged) currentEffort = msg.currentEffort;
        if (modelChanged || effortChanged) {
          renderModelSwitch(currentProvider, currentModel);
          renderEffortSwitch(currentProvider, currentModel, currentEffort);
        }
      } else if (msg.type === 'turnModel') {
        activeTurn.turnModel = msg.model;
        renderTurnStatus(activeTurn);
      } else if (msg.type === 'turnUsage') {
        activeTurn.liveTokens = msg.totalTokens;
        renderTurnStatus(activeTurn);
      } else if (msg.type === 'error') {
        stopTurnStatusTimer(activeTurn);
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
