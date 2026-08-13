import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Only the final exchange per turn is stored — not tool_calls/tool results
// from the Stage A5 agent loop. Replaying full tool history (including raw
// file contents read back) into every future request would bloat context
// and cost; the final answer is what matters for conversational continuity.
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  taskType?: string;
}

export interface ThreadMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadData extends ThreadMeta {
  messages: StoredMessage[];
}

function storageRoot(context: vscode.ExtensionContext): string {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  return context.globalStorageUri.fsPath;
}

function threadsDir(context: vscode.ExtensionContext): string {
  const dir = path.join(storageRoot(context), 'threads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(context: vscode.ExtensionContext): string {
  return path.join(storageRoot(context), 'threads-index.json');
}

function threadFilePath(context: vscode.ExtensionContext, id: string): string {
  return path.join(threadsDir(context), `${id}.json`);
}

function readIndex(context: vscode.ExtensionContext): ThreadMeta[] {
  try {
    return JSON.parse(fs.readFileSync(indexPath(context), 'utf-8'));
  } catch {
    return [];
  }
}

function writeIndex(context: vscode.ExtensionContext, index: ThreadMeta[]): void {
  fs.writeFileSync(indexPath(context), JSON.stringify(index, null, 2));
}

export const DEFAULT_THREAD_NAME = 'New Chat';

export function listThreads(context: vscode.ExtensionContext): ThreadMeta[] {
  return readIndex(context).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Derives a short thread title from a message — truncated at a word
// boundary, not mid-word. Used to auto-name a thread from its first
// message, the same way most chat apps title new conversations.
export function deriveThreadName(message: string): string {
  const clean = message.trim().replace(/\s+/g, ' ');
  const maxLen = 40;
  if (clean.length <= maxLen) return clean;
  const truncated = clean.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 15 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

export function createThread(context: vscode.ExtensionContext, name = 'New Chat'): ThreadData {
  const now = new Date().toISOString();
  const id = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const thread: ThreadData = { id, name, createdAt: now, updatedAt: now, messages: [] };

  const index = readIndex(context);
  index.push({ id, name, createdAt: now, updatedAt: now });
  writeIndex(context, index);
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));
  return thread;
}

export function loadThread(context: vscode.ExtensionContext, id: string): ThreadData | undefined {
  try {
    return JSON.parse(fs.readFileSync(threadFilePath(context, id), 'utf-8'));
  } catch {
    return undefined;
  }
}

export function saveThreadMessages(context: vscode.ExtensionContext, id: string, messages: StoredMessage[]): void {
  const thread = loadThread(context, id);
  if (!thread) return;
  thread.messages = messages;
  thread.updatedAt = new Date().toISOString();
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));

  const index = readIndex(context);
  const entry = index.find((t) => t.id === id);
  if (entry) {
    entry.updatedAt = thread.updatedAt;
    writeIndex(context, index);
  }
}

export function renameThread(context: vscode.ExtensionContext, id: string, name: string): void {
  const thread = loadThread(context, id);
  if (!thread) return;
  thread.name = name;
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));

  const index = readIndex(context);
  const entry = index.find((t) => t.id === id);
  if (entry) {
    entry.name = name;
    writeIndex(context, index);
  }
}
