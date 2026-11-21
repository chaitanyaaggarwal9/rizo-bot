// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { callOpenRouter, callWithFallback, CallOptions, ChatMessage, ContentPart, Usage } from '../api/openrouter';
import { detectTaskType, TaskType } from '../routing/modelRouter';
import { freeChainForTaskType } from '../models/freeModels';
import { loadSkillsContent } from '../prompt/skillsLoader';
import { ToolDefinition, TOOLS, executeTool, summarizeToolCall, summarizeToolResult } from '../tools/tools';
import { expandSlashCommand } from '../prompt/slashCommands';
import { loadProjectInstructions, projectInstructionsPath } from '../prompt/projectInstructions';
import {
  PROVIDERS,
  EFFORT_LEVELS,
  EffortLevel,
  DEFAULT_EFFORT,
  defaultModelForProvider,
  startingModelForProvider,
  isValidProviderModel,
  findVariant,
  supportsReasoning,
  effortForTier,
} from '../models/providers';
import { estimateStartingTier } from '../routing/complexityEstimator';
import { detectStruggle } from '../routing/struggleDetector';
import { estimateCost } from '../api/pricing';
import { getUsage, recordUsage } from '../storage/usageStore';
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
} from '../storage/threadStore';
import { frameProjectNotes, isValidThreadId } from '../safety/permissions';
import { approvedProjectNotes, requestFolderGrants } from './trustPrompts';
import { buildChatHtml } from './webviewHtml';
import { IncomingAttachment, isIncomingAttachment, readAttachmentFile, gitignoreExcludeGlobs } from '../agent/attachments';
import { findMentionedPaths } from '../agent/folderMentions';
import { planSummary, SUMMARY_MODEL } from '../agent/summarizer';
import { TurnTracker } from '../agent/turnTracker';
import { getMaxOutputTokens } from '../api/modelLimits';

const SECRET_KEY = 'rizo.openRouterApiKey';
// Holds one thread — the most recently deleted, cleared once restored.
// Not a stack: only the last deletion is recoverable.
const LAST_DELETED_THREAD_KEY = 'rizo.lastDeletedThread';

// Cheapest available model — summarizing old history is internal
// housekeeping, not a user-facing reply, so it shouldn't use the
// thread's own (possibly expensive) model.





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



export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private activeThreadId: string;
  // Running turns: one AbortController each, and one-at-a-time per thread.
  private readonly turns = new TurnTracker();
  private disposed = false;
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
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'media')),
          vscode.Uri.file(path.join(context.extensionPath, 'assets')),
        ],
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
        // One bad message (or a failed settings/thread write) must not
        // become an unhandled rejection with no feedback.
        try {
          await this.routeMessage(message);
        } catch (err: any) {
          void vscode.window.showErrorMessage(`Rizo: ${err?.message ?? String(err)}`);
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async routeMessage(message: any) {
    if (!message || typeof message !== 'object') return;
        switch (message.type) {
          case 'ready':
            this.sendInit();
            this.resolveReady();
            break;
          case 'send': {
            // Fields from the webview are checked, not trusted.
            if (typeof message.text !== 'string' || typeof message.turnId !== 'string') break;
            const attachments: IncomingAttachment[] = Array.isArray(message.attachments)
              ? message.attachments.filter(isIncomingAttachment)
              : [];
            await this.handleSend(message.text, message.turnId, attachments);
            break;
          }
          case 'cancel':
            if (typeof message.turnId === 'string') this.turns.cancel(message.turnId);
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
            // The id ends up in a file path (threads/<id>.json), so only
            // ids of threads that actually exist are accepted.
            if (!isValidThreadId(message.id) || !listThreads(this.context).some((t) => t.id === message.id)) break;
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
              this.sendStateUpdate();
            }
            break;
          }
          case 'selectEffort': {
            if ((EFFORT_LEVELS as readonly string[]).includes(message.effort)) {
              setThreadEffort(this.context, this.activeThreadId, message.effort);
              this.sendStateUpdate();
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
  }

  // Posts to the chat view unless the panel is gone. postMessage on a
  // disposed webview throws or rejects; a turn still unwinding after the
  // panel closed must not turn that into an unhandled rejection.
  private post(message: unknown): void {
    if (this.disposed) return;
    try {
      void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
    } catch {
      /* panel disposed between the check and the call */
    }
  }

  // Everything init carries except the message list: used for changes
  // that can happen mid-turn (model, effort, rename) so the live reply,
  // the Stop button and queued messages aren't reset.
  private sendStateUpdate() {
    const thread = loadThread(this.context, this.activeThreadId);
    const messages = thread?.messages || [];
    const usage = getUsage(this.context);
    this.post({
      type: 'stateUpdate',
      threads: listThreads(this.context),
      activeThreadId: this.activeThreadId,
      provider: thread?.provider,
      model: thread?.model,
      effort: thread?.effort || DEFAULT_EFFORT,
      threadTokens: sumThreadTokens(messages),
      threadCost: sumThreadCost(messages),
      dayTokens: usage.dayTokens,
      monthCost: usage.monthCost,
    });
  }

  private sendInit() {
    const thread = loadThread(this.context, this.activeThreadId);
    const messages = thread?.messages || [];
    const usage = getUsage(this.context);
    this.post({
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
    this.post({
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
      this.sendStateUpdate();
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
      ...gitignoreExcludeGlobs(folder.uri.fsPath),
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
    this.post({ type: 'prefillComposer', text });
  }

  private async readAndSendAttachment(fsPath: string) {
    const result = readAttachmentFile(fsPath);
    if ('warning' in result) {
      vscode.window.showWarningMessage(result.warning);
      return;
    }
    this.post({ type: 'attachmentAdded', attachment: result.attachment });
  }


  // Past SUMMARIZE_THRESHOLD messages, folds everything older than
  // SUMMARY_KEEP_TAIL into a running summary via one cheap-tier call —
  // only affects what's sent to the model, not what's stored/shown.
  // Fire-and-forget from handleSend, so a failure just means retry next
  // turn.
  private async maybeSummarize(apiKey: string, threadId: string) {
    const thread = loadThread(this.context, threadId);
    if (!thread) return;
    const plan = planSummary(thread.messages, thread.summarizedCount || 0, thread.summary);
    if (!plan) return;
    try {
      const { message } = await callOpenRouter(apiKey, SUMMARY_MODEL, plan.prompt);
      const newSummary = (message.content as string) || thread.summary || '';
      if (newSummary) updateThreadSummary(this.context, threadId, newSummary, plan.foldEnd);
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
    // Waits for any earlier turn on this thread to finish first, so two
    // turns never load the same history and overwrite each other.
    const turn = this.turns.begin(turnId, threadId);
    try {
      await turn.ready;
      if (turn.signal.aborted) {
        this.post({ type: 'cancelled', turnId });
        return;
      }
      await this.runTurn(text, turnId, attachments, threadId, turn.signal);
    } finally {
      turn.finish();
    }
  }

  private async runTurn(
    text: string,
    turnId: string,
    attachments: IncomingAttachment[],
    threadId: string,
    signal: AbortSignal,
  ) {

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.post({ type: 'error', error: 'No API key provided.', turnId });
      return;
    }

    const startedAt = Date.now();
    // Hoisted above the try so the catch block can still persist it on a
    // genuine failure (network error, etc.) — see the catch block below.
    let userContent: string | ContentPart[] | undefined;
    // Files this turn read or changed (deduplicated). Also hoisted, so a
    // failed turn's saved error can say what it had already touched.
    const touchedFilesThisTurn = new Set<string>();

    const thread = loadThread(this.context, threadId);
    if (!thread?.provider || !thread?.model) {
      this.post({ type: 'error', error: 'Pick a provider for this chat first.', turnId });
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

      // A real path outside the workspace that this message names is
      // offered to the user ("Let Rizo read files there for this chat?").
      // Only folders they allow, in this workspace, are usable.
      const workspaceRoots = (vscode.workspace.workspaceFolders || []).map((f) => {
        try {
          return fs.realpathSync(f.uri.fsPath);
        } catch {
          return f.uri.fsPath;
        }
      });
      const extraRoots = await requestFolderGrants(this.context, threadId, findMentionedPaths(effectiveText), workspaceRoots);

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

      // The repository's .rizo/instructions.md, if present and the user
      // agreed to use this version of it (asked once per version). Not
      // gated to 'coding', since project context can matter for any
      // reply. Framed as repository content, not as instructions.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const projectNotes = await approvedProjectNotes(
        this.context,
        loadProjectInstructions(workspaceRoot),
        projectInstructionsPath(workspaceRoot),
      );
      if (projectNotes) systemParts.push(frameProjectNotes(projectNotes));

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
          this.post({
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
      // No step limit by default: a turn runs until the model answers
      // without calling a tool, or the user presses Stop. Users who want a
      // cap set rizo.limits.maxStepsPerTurn (0 = no limit).
      const limits = vscode.workspace.getConfiguration('rizo.limits');
      const maxSteps = Math.max(0, Math.floor(Number(limits.get<number>('maxStepsPerTurn', 0)) || 0));
      const maxOutputTokens = Math.max(0, Math.floor(Number(limits.get<number>('maxOutputTokens', 0)) || 0));
      let finalReply = `I stopped after ${maxSteps} steps (your rizo.limits.maxStepsPerTurn setting) — say 'continue' and I'll pick back up.`;
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

      // Sent after Smart Starting Variant resolves model, so the bubble
      // never shows a value that turns out wrong.
      this.post({ type: 'turnModel', turnId, model });

      for (let step = 0; maxSteps === 0 || step < maxSteps; step++) {
        if (signal.aborted) break;

        const { model: usedModel, message, usage, finishReason } = await this.callModel(apiKey, provider, model, taskType, messages, hasImage, enabledTools, {
          signal,
          // Dropped for a variant that doesn't support it rather than sent
          // and possibly rejected; callWithFallback never forwards it
          // regardless.
          reasoningEffort: supportsReasoning(provider, model) ? effort : undefined,
          // Each model's full maximum reply length (or the user's cap).
          maxTokens: maxOutputTokens || undefined,
          maxTokensFor: (m) => getMaxOutputTokens(m),
          onDelta: (chunk) => this.post({ type: 'textDelta', turnId, text: chunk }),
          // Clears partial streamed text before the next model's attempt,
          // so the two don't visually run together.
          onRestart: () => this.post({ type: 'textReset', turnId }),
        });
        answeredBy = usedModel;
        totalUsage.promptTokens += usage.promptTokens;
        totalUsage.completionTokens += usage.completionTokens;
        totalUsage.totalTokens += usage.totalTokens;
        // Running total — a multi-tool-call turn makes several round-trips.
        this.post({ type: 'turnUsage', turnId, totalTokens: totalUsage.totalTokens });

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
          if (signal.aborted) break;
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
          this.post({
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
            : await executeTool(this.context, toolCall.function.name, toolCall.function.arguments, extraRoots, threadId, signal);
          const toolOk = !result.startsWith('Error:');
          this.post({
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

      // Stopped: the chat view already shows "Stopped.". Nothing is saved,
      // so a half-finished turn isn't replayed to the model as if it
      // were a real answer.
      if (signal.aborted) {
        this.post({ type: 'cancelled', turnId });
        return;
      }

      const elapsedMs = Date.now() - startedAt;

      // previousAssistantMsg reads thread.messages before this turn's own
      // exchange is appended below, so it's genuinely the prior turn.
      // Offered only when a stronger variant exists in this provider
      // (company-locked) — Free and an already-top-tier turn never show a
      // dead button.
      const previousAssistantMsg = [...(thread?.messages || [])].reverse().find((m) => m.role === 'assistant');
      const struggled = detectStruggle({
        wasCancelled: signal.aborted,
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
      // Re-read the thread first: it may have been renamed or summarized
      // while this turn ran, and those changes must not be lost.
      const latest = loadThread(this.context, threadId) ?? thread;
      const updated: StoredMessage[] = [
        ...latest.messages,
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
      if (thread.messages.length === 0 && latest.name === DEFAULT_THREAD_NAME) {
        renameThread(this.context, threadId, deriveThreadName(effectiveText));
        this.post({
          type: 'threadListUpdated',
          threads: listThreads(this.context),
          activeThreadId: this.activeThreadId,
        });
      }

      this.post({
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
        this.post({ type: 'cancelled', turnId });
      } else if (/user not found|401|unauthorized/i.test(err.message)) {
        // "User not found" / 401 means OpenRouter didn't recognize the key
        // at all — clear it so the next send re-prompts instead of failing
        // forever on a bad stored key.
        await this.context.secrets.delete(SECRET_KEY);
        const error = `${err.message} — cleared the stored key. Send your message again to re-enter it.`;
        this.post({ type: 'error', turnId, error });
        this.persistFailedTurn(threadId, userContent, error);
      } else {
        this.post({ type: 'error', turnId, error: err.message });
        const touched = touchedFilesThisTurn.size
          ? `\n\n(Before the error, this turn had already read or changed: ${[...touchedFilesThisTurn].join(', ')}.)`
          : '';
        this.persistFailedTurn(threadId, userContent, `Error: ${err.message}${touched}`);
      }
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
    return buildChatHtml(this.panel.webview, this.context.extensionPath);
  }

  public dispose() {
    // Closing the panel stops its turns: no more tokens spent, and an
    // approval answered after this won't be applied (tools.ts checks the
    // turn's signal before writing or running anything).
    this.disposed = true;
    this.turns.cancelAll();
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
