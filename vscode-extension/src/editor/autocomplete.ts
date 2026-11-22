// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Autocomplete: ghost-text suggestions as you type (Tab accepts). Off by
// default because every suggestion is a paid request; turn it on with
// rizo.autocomplete.enabled. Never runs on files that usually hold
// secrets, waits for a pause in typing, and cancels requests you've typed
// past.

import * as vscode from 'vscode';
import { buildCompletionMessages, cleanCompletion, COMPLETION_PREFIX, COMPLETION_SUFFIX } from './inlinePrompts';
import { complete, configuredModel, isSecretDocument, openRouterKey, relativePath } from './editorModel';

export const DEFAULT_COMPLETION_MODEL = 'google/gemini-3.5-flash-lite';
const DEBOUNCE_MS = 350;
const MAX_COMPLETION_TOKENS = 256;
// Big files are skipped: the slices sent are small, but reading them on
// every keystroke isn't free.
const MAX_DOCUMENT_CHARS = 2_000_000;

function enabled(): boolean {
  return vscode.workspace.getConfiguration('rizo').get<boolean>('autocomplete.enabled', false);
}

function wait(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!token.isCancellationRequested), ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export class RizoCompletionProvider implements vscode.InlineCompletionItemProvider {
  private noKeyWarned = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!enabled() || !['file', 'untitled', 'vscode-notebook-cell'].includes(doc.uri.scheme)) return undefined;
    if (isSecretDocument(doc) || doc.getText().length > MAX_DOCUMENT_CHARS) return undefined;
    // The suggest widget is open: let it be.
    if (ctx.selectedCompletionInfo) return undefined;
    const lineAfter = doc.lineAt(position.line).text.slice(position.character);
    // Mid-word or mid-line (other than closing brackets and quotes): skip.
    if (/[^\s)\]}>"'`;,]/.test(lineAfter)) return undefined;

    if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && !(await wait(DEBOUNCE_MS, token))) return undefined;

    const apiKey = await openRouterKey(this.context);
    if (!apiKey) {
      if (!this.noKeyWarned) {
        this.noKeyWarned = true;
        void vscode.window.showWarningMessage('Rizo autocomplete needs your OpenRouter API key. Run "Rizo: Change API Key".');
      }
      return undefined;
    }

    const offset = doc.offsetAt(position);
    const prefix = doc.getText(new vscode.Range(doc.positionAt(Math.max(0, offset - COMPLETION_PREFIX * 2)), position));
    const suffix = doc.getText(new vscode.Range(position, doc.positionAt(offset + COMPLETION_SUFFIX * 2)));
    if (!prefix.trim()) return undefined;

    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());
    try {
      const model = configuredModel('autocomplete.model', DEFAULT_COMPLETION_MODEL);
      const messages = buildCompletionMessages({ path: relativePath(doc), language: doc.languageId, prefix, suffix });
      const reply = await complete(this.context, apiKey, model, messages, MAX_COMPLETION_TOKENS, ac.signal);
      if (token.isCancellationRequested) return undefined;
      const text = cleanCompletion(reply, prefix, suffix);
      return text ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : undefined;
    } catch {
      // Autocomplete fails quietly (offline, rate limited); the chat
      // reports errors properly.
      return undefined;
    } finally {
      sub.dispose();
    }
  }
}

export function registerAutocomplete(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new RizoCompletionProvider(context));
}
