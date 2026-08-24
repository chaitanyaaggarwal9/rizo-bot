// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { estimateCost } from './pricing';
import { ContentPart } from './openrouter';

// Only the final exchange per turn is stored, not tool_calls/tool results
// — replaying full tool history into every future request would bloat
// context and cost. promptTokens/completionTokens are stored separately
// (not just the total) since they're priced differently per model.
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  model?: string;
  taskType?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // Set on assistant turns only — whether this turn called any tool, and
  // whether any mutated something (write_file/edit_file) vs just reading.
  // handleSend compares against the previous stored turn to catch
  // cross-turn stagnation — two turns in a row that only read, never
  // wrote. Undefined on older messages, never treated as false, so old
  // history can't retroactively trigger it.
  madeToolCall?: boolean;
  madeMutatingCall?: boolean;
  // Workspace-relative paths this turn's read/write/edit calls touched.
  // Powers search_past_work (tools.ts) — cross-thread "have I touched
  // this file before" recall, built from data already in hand.
  // Deduplicated per turn but not across a thread's history — repetition
  // across turns is itself part of what search_past_work reports.
  touchedFiles?: string[];
}

// Sums totalTokens across every assistant message in a thread — the
// running "tokens used in this chat" figure, computed from what's already
// persisted rather than tracked separately.
export function sumThreadTokens(messages: StoredMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.totalTokens || 0), 0);
}

// Sums estimated $ cost across every assistant message — free-tier
// messages contribute $0 automatically (see pricing.ts).
export function sumThreadCost(messages: StoredMessage[]): number {
  return messages.reduce((sum, m) => {
    if (!m.model || !m.promptTokens || !m.completionTokens) return sum;
    return sum + estimateCost(m.model, m.promptTokens, m.completionTokens);
  }, 0);
}

export interface ThreadMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadData extends ThreadMeta {
  messages: StoredMessage[];
  // Running summary of everything older than summarizedCount, folded in
  // once the thread gets long (chatPanel.ts's maybeSummarize). Keeps long
  // threads from replaying full raw history into every request — the UI
  // still shows every message; this only affects what's sent to the model.
  summary?: string;
  summarizedCount?: number;
  // Set once, from the new-chat provider picker, never changed to a
  // different company for this thread's life — the switcher only offers
  // other variants within it. Undefined means "not picked yet".
  provider?: string;
  model?: string;
  // How hard the current model thinks — independent of provider/variant,
  // adjustable per turn via the Effort switcher next to the model pill.
  // Undefined is treated as providers.ts's DEFAULT_EFFORT ('medium').
  effort?: 'low' | 'medium' | 'high';
  // True once the user touches the Effort switcher — permanently opts out
  // of effort auto-suggestion, same "explicit choice wins over a guess"
  // rule Smart Starting Variant applies. Unlike that one-shot check,
  // effort auto-suggestion re-evaluates every turn — this flag keeps a
  // manual override from being clobbered by the next guess.
  effortManuallySet?: boolean;
  // Sticky, monotonic — once a message classifies as 'coding', the thread
  // stays 'coding', even when a later message ("yes", "continue") has no
  // trigger word itself. Without this, a mid-task follow-up could
  // silently lose skill-file loading. Undefined/'general' means not
  // upgraded yet.
  taskType?: 'coding' | 'general';
  // Absolute paths outside every open workspace folder that this thread
  // is allowed to read/write — populated only when the human's own
  // message text names a real path, never from a model's tool-call
  // arguments. Same trust boundary as tools.ts's workspace check: a model
  // reaching outside the workspace on its own (possibly via prompt
  // injection) is the risk that boundary stops; a human naming a path
  // deliberately isn't that risk. Persisted per-thread, so a folder
  // mentioned once stays usable for the rest of the conversation.
  extraRoots?: string[];
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

// Derives a short thread title from a message, truncated at a word
// boundary.
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

// Removes the thread file and its index entry. Silently no-ops on an
// already-missing file — the end state is what the caller wants either
// way.
export function deleteThread(context: vscode.ExtensionContext, id: string): void {
  try {
    fs.unlinkSync(threadFilePath(context, id));
  } catch {
    // already gone
  }
  writeIndex(context, readIndex(context).filter((t) => t.id !== id));
}

// Writes a full thread back to disk, plus its index entry — the undo path
// for a deleted thread. Bumps updatedAt to now so a restored thread sorts
// back to the top.
export function restoreThread(context: vscode.ExtensionContext, thread: ThreadData): void {
  const restored: ThreadData = { ...thread, updatedAt: new Date().toISOString() };
  fs.writeFileSync(threadFilePath(context, restored.id), JSON.stringify(restored, null, 2));

  const index = readIndex(context).filter((t) => t.id !== restored.id);
  index.push({ id: restored.id, name: restored.name, createdAt: restored.createdAt, updatedAt: restored.updatedAt });
  writeIndex(context, index);
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

// Sets (or changes the variant within) this thread's locked provider — the
// only writer of ThreadData.provider/model. chatPanel.ts enforces the
// same-provider restriction before calling this.
export function setThreadModel(context: vscode.ExtensionContext, id: string, provider: string, model: string): void {
  const thread = loadThread(context, id);
  if (!thread) return;
  thread.provider = provider;
  thread.model = model;
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));
}

// Merges newly-detected paths into extraRoots — additive and deduped,
// never removes a prior root. Only called with paths already verified to
// exist and come from the human's own message text.
export function addThreadExtraRoots(context: vscode.ExtensionContext, id: string, roots: string[]): void {
  if (roots.length === 0) return;
  const thread = loadThread(context, id);
  if (!thread) return;
  const merged = new Set([...(thread.extraRoots || []), ...roots]);
  thread.extraRoots = [...merged];
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));
}

export function setThreadEffort(context: vscode.ExtensionContext, id: string, effort: 'low' | 'medium' | 'high'): void {
  const thread = loadThread(context, id);
  if (!thread) return;
  thread.effort = effort;
  // Every call to this function IS the user picking from the Effort
  // switcher (its only caller) — see effortManuallySet's own comment.
  thread.effortManuallySet = true;
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));
}

// Upgrades the thread to 'coding' the first time any message earns it —
// never downgrades back to 'general'. No-op if the thread is already
// 'coding' (avoids a pointless disk write on every single turn).
export function upgradeThreadTaskType(context: vscode.ExtensionContext, id: string, taskType: 'coding' | 'general'): void {
  if (taskType !== 'coding') return;
  const thread = loadThread(context, id);
  if (!thread || thread.taskType === 'coding') return;
  thread.taskType = 'coding';
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));
}

export function updateThreadSummary(
  context: vscode.ExtensionContext,
  id: string,
  summary: string,
  summarizedCount: number,
): void {
  const thread = loadThread(context, id);
  if (!thread) return;
  thread.summary = summary;
  thread.summarizedCount = summarizedCount;
  fs.writeFileSync(threadFilePath(context, id), JSON.stringify(thread, null, 2));
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
