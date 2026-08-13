import * as vscode from 'vscode';
import * as path from 'path';
import { callOpenRouter, ChatMessage } from './openrouter';
import { modelForMessage } from './modelRouter';
import { loadSkillsContent } from './skillsLoader';
import { TOOLS, executeTool } from './tools';
import {
  StoredMessage,
  ThreadMeta,
  DEFAULT_THREAD_NAME,
  listThreads,
  createThread,
  loadThread,
  saveThreadMessages,
  renameThread,
  deriveThreadName,
} from './threadStore';

const MAX_TOOL_ITERATIONS = 8;

const SECRET_KEY = 'chaiAgent.openRouterApiKey';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
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
      'chaiAgentChat',
      'Chai Agent',
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
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private sendInit() {
    const thread = loadThread(this.context, this.activeThreadId);
    this.panel.webview.postMessage({
      type: 'init',
      threads: listThreads(this.context),
      activeThreadId: this.activeThreadId,
      messages: thread?.messages || [],
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

  private async handleSend(text: string) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.panel.webview.postMessage({ type: 'error', error: 'No API key provided.' });
      return;
    }

    try {
      const { model, taskType } = modelForMessage(text);

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

      let answeredBy = model;
      let finalReply = '(no final response — hit the tool-call iteration limit)';

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const { model: usedModel, message } = await callOpenRouter(apiKey, model, messages, TOOLS);
        answeredBy = usedModel;

        if (!message.tool_calls || message.tool_calls.length === 0) {
          finalReply = message.content || '';
          break;
        }

        // Record the assistant's tool-call turn before executing anything,
        // so history stays valid even if a tool call throws.
        messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls });

        for (const toolCall of message.tool_calls) {
          this.panel.webview.postMessage({
            type: 'progress',
            text: `Running ${toolCall.function.name}(${toolCall.function.arguments})...`,
          });
          const result = await executeTool(toolCall.function.name, toolCall.function.arguments);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        }
      }

      // Persist only the final exchange — not the tool-call sub-steps.
      const updated: StoredMessage[] = [
        ...(thread?.messages || []),
        { role: 'user', content: text },
        { role: 'assistant', content: finalReply, model: answeredBy, taskType },
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

      this.panel.webview.postMessage({ type: 'reply', model: answeredBy, taskType, reply: finalReply });
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
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
  #threadBar { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border); align-items: center; }
  #threadSelect { flex: 1; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 4px 6px; }
  #threadBar button { padding: 4px 10px; font-size: 12px; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 80%; padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .msg.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); }
  .model-tag { display: block; font-size: 10px; opacity: 0.6; margin-bottom: 4px; }
  #inputBar { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--vscode-widget-border); }
  #inputBox { flex: 1; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; }
  button { padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
  <div id="threadBar">
    <select id="threadSelect"></select>
    <button id="newThreadBtn">New</button>
    <button id="renameThreadBtn">Rename</button>
  </div>
  <div id="messages"></div>
  <div id="inputBar">
    <input id="inputBox" placeholder="Message..." />
    <button id="sendBtn">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('inputBox');
    const sendBtn = document.getElementById('sendBtn');
    const threadSelect = document.getElementById('threadSelect');
    const newThreadBtn = document.getElementById('newThreadBtn');
    const renameThreadBtn = document.getElementById('renameThreadBtn');
    let thinkingEl = null;

    function addMessage(role, text, model, taskType) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'assistant' && model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = taskType ? model + '  ·  ' + taskType : model;
        div.appendChild(tag);
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
        addMessage(m.role, m.content, m.model, m.taskType);
      }
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      addMessage('user', text);
      inputEl.value = '';
      sendBtn.disabled = true;
      thinkingEl = addMessage('assistant', 'Thinking...');
      vscode.postMessage({ type: 'send', text });
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    newThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
    renameThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'renameThread' }));
    threadSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'switchThread', id: threadSelect.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        if (thinkingEl) thinkingEl.querySelector('span:last-child').textContent = msg.text;
        return;
      }
      if (msg.type === 'init') {
        renderThreadList(msg.threads, msg.activeThreadId);
        renderMessages(msg.messages);
        return;
      }
      if (msg.type === 'threadListUpdated') {
        renderThreadList(msg.threads, msg.activeThreadId);
        return;
      }
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      sendBtn.disabled = false;
      if (msg.type === 'reply') {
        addMessage('assistant', msg.reply, msg.model, msg.taskType);
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
