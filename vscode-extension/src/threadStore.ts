// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { estimateCost } from './pricing';
import { ContentPart } from './openrouter';

// Only the final exchange per turn is stored — not tool_calls/tool results
// from the Stage A5 agent loop. Replaying full tool history (including raw
// file contents read back) into every future request would bloat context
// and cost; the final answer is what matters for conversational continuity.
// promptTokens/completionTokens are stored separately (not just the total)
// because they're priced very differently per model — cost can't be
// recovered accurately from the total alone.
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  model?: string;
  taskType?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // Set on assistant turns only — whether this turn called any tool at
  // all, and whether any of those calls actually mutated something
  // (write_file/edit_file) rather than just reading/listing. handleSend
  // compares the current turn's own pair against the *previous* stored
  // assistant turn's to catch cross-turn stagnation: two turns in a row
  // that both poked around with tools but never wrote anything — the
  // "keeps checking the same broken file instead of fixing it" failure
  // mode a single turn's own tool-error/iteration-cap signals can't see.
  // Undefined on messages persisted before this existed — deliberately
  // never treated as false, so old history can't retroactively trigger it.
  madeToolCall?: boolean;
  madeMutatingCall?: boolean;
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
  // Running summary of everything older than the last `summarizedCount`
  // messages, folded in once the thread gets long — see
  // chatPanel.ts's maybeSummarize(). Keeps long threads from replaying
  // their full raw history (and its token cost) into every new request,
  // while the UI still shows every message in full — this only affects
  // what gets sent to the model, never what's stored or displayed.
  summary?: string;
  summarizedCount?: number;
  // Set once, from the new-chat provider picker, and never changed to a
  // different company for this thread's lifetime — see providers.ts. The
  // in-chat switcher only ever offers other variants within this same
  // provider. Undefined means "not picked yet" — the webview shows the
  // picker instead of the composer until this is set.
  provider?: string;
  model?: string;
  // How hard the current model thinks — independent of provider/variant,
  // adjustable per turn via the Effort switcher next to the model pill.
  // Undefined is treated as providers.ts's DEFAULT_EFFORT ('medium').
  effort?: 'low' | 'medium' | 'high';
  // True the moment the user ever touches the Effort switcher themselves
  // (see setThreadEffort — its only caller is that switcher's handler) —
  // permanently opts this thread out of effort auto-suggestion
  // (chatPanel.ts's handleSend), same "an explicit choice always wins
  // over a guess" rule Smart Starting Variant applies to the model pick.
  // Unlike that one-shot check, effort auto-suggestion re-evaluates every
  // turn (effort is a per-request parameter, not a thread-level identity
  // trait) — this flag is what keeps a single manual override from being
  // silently clobbered by the very next message's guess.
  effortManuallySet?: boolean;
  // Sticky, monotonic: once a message in this thread classifies as
  // 'coding', the thread stays 'coding' for the rest of its life, even
  // when a later message ("yes", an email address, "continue") doesn't
  // itself contain a trigger word — see chatPanel.ts's handleSend. Without
  // this, skill-file loading (loadSkillsContent) was reclassified fresh
  // per message with no memory of an in-progress task, and a mid-task
  // follow-up could silently lose Coding Discipline for the rest of the
  // conversation. Undefined/'general' means "not upgraded yet."
  taskType?: 'coding' | 'general';
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

// Removes the thread file and its index entry. Silently no-ops on an
// already-missing file (e.g. a double-click on Delete) rather than
// throwing — the end state ("this thread doesn't exist") is what the
// caller actually wants either way.
export function deleteThread(context: vscode.ExtensionContext, id: string): void {
  try {
    fs.unlinkSync(threadFilePath(context, id));
  } catch {
    // already gone
  }
  writeIndex(context, readIndex(context).filter((t) => t.id !== id));
}

// Writes a full thread back to disk exactly as handed in, plus its index
// entry — the "Reopen Closed Session" undo path in chatPanel.ts, which
// stashes a deleted thread's data before deleteThread() runs. Bumps
// updatedAt to now so a restored thread sorts back to the top of the list
// (matching "this just came back"), rather than wherever it was before.
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
// only writer of ThreadData.provider/model. Called from the provider picker
// (first pick) and the in-chat variant switcher (same-provider swap only;
// chatPanel.ts is what enforces the "same provider" restriction before
// calling this).
export function setThreadModel(context: vscode.ExtensionContext, id: string, provider: string, model: string): void {
  const thread = loadThread(context, id);
  if (!thread) return;
  thread.provider = provider;
  thread.model = model;
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
