// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// One model request for the editor features (inline edit, autocomplete),
// through OpenRouter with the user's key, counted in the usage totals.

import * as vscode from 'vscode';
import { callOpenRouter, ChatMessage } from '../api/openrouter';
import { getCachedCatalog } from '../api/modelCatalog';
import { estimateCost } from '../api/pricing';
import { recordUsage } from '../storage/usageStore';
import { isSecretFile } from '../safety/permissions';
import { SECRET_KEY } from '../ui/chatPanel';

// "provider/model" or "provider/model:variant", nothing else.
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;

export function configuredModel(setting: string, fallback: string): string {
  const value = vscode.workspace.getConfiguration('rizo').get<string>(setting, '').trim();
  return MODEL_ID.test(value) ? value : fallback;
}

export async function openRouterKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return (await context.secrets.get(SECRET_KEY))?.trim() || undefined;
}

export function relativePath(doc: vscode.TextDocument): string {
  return doc.isUntitled ? doc.fileName : vscode.workspace.asRelativePath(doc.uri, false);
}

// Files that usually hold secrets (.env, keys) are never sent for
// autocomplete, and inline edit asks first.
export function isSecretDocument(doc: vscode.TextDocument): boolean {
  return !doc.isUntitled && isSecretFile(doc.uri.fsPath);
}

export async function complete(
  context: vscode.ExtensionContext,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  signal: AbortSignal,
): Promise<string> {
  const result = await callOpenRouter(apiKey, model, messages, undefined, { signal, maxTokens });
  const cost = result.usage.cost ?? estimateCost(result.model, result.usage.promptTokens, result.usage.completionTokens, getCachedCatalog());
  recordUsage(context, result.usage.totalTokens, cost);
  return typeof result.message.content === 'string' ? result.message.content : '';
}
