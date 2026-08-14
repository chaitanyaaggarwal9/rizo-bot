import * as vscode from 'vscode';
import * as path from 'path';
import { callOpenRouter, callWithFallback, ChatMessage, Usage } from './openrouter';
import { modelForMessage, MODEL_FOR_TASK, TaskType } from './modelRouter';
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
  sumThreadTokens,
  sumThreadCost,
} from './threadStore';

const MAX_TOOL_ITERATIONS = 8;

const SECRET_KEY = 'rizo.openRouterApiKey';
const FREE_MODE_KEY = 'rizo.freeMode';

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
            await this.handleSend(message.text);
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
  private async callModel(apiKey: string, taskType: TaskType, messages: ChatMessage[]) {
    if (this.isFreeMode()) {
      return callWithFallback(apiKey, freeChainForTaskType(taskType), messages, TOOLS);
    }
    return callOpenRouter(apiKey, MODEL_FOR_TASK[taskType], messages, TOOLS);
  }

  private async handleSend(text: string) {
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

      // Replay this thread's prior turns (final exchanges only, not tool
      // calls — see threadStore.ts) so follow-ups have real context.
      const thread = loadThread(this.context, this.activeThreadId);
      const history: ChatMessage[] = (thread?.messages || []).map((m) => ({ role: m.role, content: m.content }));

      const messages: ChatMessage[] = [
        { role: 'system', content: systemParts.join('\n\n---\n\n') },
        ...history,
        { role: 'user', content: text },
      ];

      let answeredBy = '';
      let finalReply = '(no final response — hit the tool-call iteration limit)';
      const totalUsage = emptyUsage();

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const { model: usedModel, message, usage } = await this.callModel(apiKey, taskType, messages);
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
        { role: 'user', content: text },
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
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
     spending mode is never ambiguous. */
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
    color: var(--vscode-foreground);
    border: none;
    border-radius: 999px;
    padding: 4px 14px;
    font-size: 12px;
    cursor: pointer;
    opacity: 0.6;
  }
  .modeOption.active {
    opacity: 1;
    background: var(--vscode-badge-background, rgba(128,128,128,0.2));
    font-weight: 600;
  }
  .modeOption[data-mode="free"].active { color: var(--vscode-charts-green, #2ea043); }
  .modeOption[data-mode="paid"].active { color: var(--vscode-charts-orange, #cc8800); }

  /* --- Messages --- */
  #messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
  .msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-bottom-left-radius: 4px; }
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
  #composerWrap { border-top: 1px solid var(--vscode-widget-border); padding: 10px 12px 6px; }
  #composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 14px;
    padding: 8px 8px 8px 14px;
  }
  #composer:focus-within { border-color: var(--vscode-focusBorder); }
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
      <button class="modeOption" id="freeOption" data-mode="free">🆓 Free</button>
      <button class="modeOption" id="paidOption" data-mode="paid">💰 Paid</button>
    </div>
  </div>
  <div id="messages"></div>
  <div id="composerWrap">
    <div id="composer">
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

    function addMessage(role, text, model, taskType, usage, elapsedMs) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'assistant' && model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = formatTag(model, taskType, usage, elapsedMs);
        div.appendChild(tag);
        div.appendChild(document.createElement('br'));
      }
      const span = document.createElement('span');
      span.textContent = text;
      div.appendChild(span);
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

    function renderMessages(messages) {
      messagesEl.innerHTML = '';
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

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      addMessage('user', text);
      inputEl.value = '';
      autoGrow();
      sendBtn.disabled = true;
      // Tool activity stays hidden — this bubble never updates with
      // per-step detail, only gets replaced by the final reply.
      thinkingEl = addMessage('assistant', 'Thinking...');
      vscode.postMessage({ type: 'send', text });
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
