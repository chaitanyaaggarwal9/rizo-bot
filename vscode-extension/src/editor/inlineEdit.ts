// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// "Rizo: Edit Selection" (Cmd+Alt+K / Ctrl+Alt+K): select code, describe
// the change, and Rizo rewrites it in place. With nothing selected it
// writes new code at the cursor. The change is highlighted and can be
// kept or undone; it's an ordinary unsaved edit, so Cmd+Z works too.

import * as vscode from 'vscode';
import { buildEditMessages, extractEditedCode, MAX_SELECTION_CHARS } from './inlinePrompts';
import { complete, configuredModel, isSecretDocument, openRouterKey, relativePath } from './editorModel';

export const DEFAULT_EDIT_MODEL = 'anthropic/claude-sonnet-5.5';

const highlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  isWholeLine: true,
});

// args.instruction skips the input box (keybindings with "args", and the
// end-to-end tests).
export async function inlineEdit(context: vscode.ExtensionContext, args?: { instruction?: unknown }): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a file and select some code to edit with Rizo.');
    return;
  }
  const doc = editor.document;
  // Whole lines: a half-selected line would come back re-indented.
  const sel = editor.selection;
  const range = doc.validateRange(
    sel.isEmpty
      ? new vscode.Range(sel.active, sel.active)
      : new vscode.Range(sel.start.line, 0, sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1, 0),
  );
  const original = doc.getText(range);
  if (original.length > MAX_SELECTION_CHARS) {
    void vscode.window.showWarningMessage('That selection is too large for an inline edit. Ask in the Rizo chat instead.');
    return;
  }
  if (isSecretDocument(doc)) {
    const send = 'Send anyway';
    const pick = await vscode.window.showWarningMessage(
      `${relativePath(doc)} usually holds secrets.`,
      { modal: true, detail: 'Its contents would be sent to the AI provider. Continue?' },
      send,
    );
    if (pick !== send) return;
  }

  const given = typeof args?.instruction === 'string' && args.instruction.trim() ? args.instruction : undefined;
  const instruction = given ?? await vscode.window.showInputBox({
    title: original ? 'Rizo: edit selection' : 'Rizo: write code here',
    prompt: original ? 'Describe the change' : 'Describe the code to add at the cursor',
    placeHolder: original ? 'e.g. add error handling, convert to async/await' : 'e.g. a function that parses ISO dates',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const apiKey = await openRouterKey(context);
  if (!apiKey) {
    const open = 'Add key';
    if ((await vscode.window.showWarningMessage('Rizo needs your OpenRouter API key first.', open)) === open) {
      await vscode.commands.executeCommand('rizo.changeApiKey');
    }
    return;
  }

  const model = configuredModel('inlineEdit.model', DEFAULT_EDIT_MODEL);
  const versionBefore = doc.version;
  const messages = buildEditMessages({
    path: relativePath(doc),
    language: doc.languageId,
    before: doc.getText(new vscode.Range(new vscode.Position(0, 0), range.start)),
    selection: original,
    after: doc.getText(new vscode.Range(range.end, doc.lineAt(doc.lineCount - 1).range.end)),
    instruction,
  });

  let reply: string;
  try {
    reply = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rizo is editing (${model})...`, cancellable: true },
      (_progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        // Room for a full rewrite of the selection, and some to spare.
        const maxTokens = Math.min(32_000, Math.max(1_024, Math.ceil(original.length / 2)));
        return complete(context, apiKey, model, messages, maxTokens, ac.signal);
      },
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    void vscode.window.showErrorMessage(`Rizo couldn't edit: ${err?.message ?? String(err)}`);
    return;
  }

  const code = extractEditedCode(reply, original);
  if (!code.trim()) {
    void vscode.window.showWarningMessage('Rizo returned no code. Try rephrasing the instruction.');
    return;
  }
  if (doc.version !== versionBefore) {
    void vscode.window.showWarningMessage('The file changed while Rizo was working, so the edit was not applied. Try again.');
    return;
  }
  if (code === original) {
    void vscode.window.showInformationMessage('Rizo made no changes.');
    return;
  }

  const ok = await editor.edit((b) => b.replace(range, code));
  if (!ok) return;
  const start = range.start;
  const endOffset = doc.offsetAt(start) + code.length;
  const newRange = new vscode.Range(start, doc.positionAt(endOffset));
  const versionAfter = doc.version;
  editor.setDecorations(highlight, [newRange]);
  editor.revealRange(newRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  const keep = 'Keep';
  const undo = 'Undo';
  const lines = code.split('\n').length - (code.endsWith('\n') ? 1 : 0);
  const choice = await vscode.window.showInformationMessage(`Rizo changed ${lines} line${lines === 1 ? '' : 's'}.`, keep, undo);
  editor.setDecorations(highlight, []);
  if (choice !== undo) return;
  if (doc.version !== versionAfter) {
    void vscode.window.showWarningMessage('The file was edited since, so Rizo left it as is. Use Undo (Cmd+Z / Ctrl+Z) instead.');
    return;
  }
  const target = vscode.window.visibleTextEditors.find((e) => e.document === doc) ?? editor;
  await target.edit((b) => b.replace(newRange, original));
}
