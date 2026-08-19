// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { registerTodoCodeLens } from './todoCodeLens';

export function activate(context: vscode.ExtensionContext) {
  const openChat = vscode.commands.registerCommand('rizo.openChat', () => {
    ChatPanel.createOrShow(context);
  });
  const changeApiKey = vscode.commands.registerCommand('rizo.changeApiKey', () => {
    ChatPanel.changeApiKey(context);
  });
  // Not bound to Cmd/Ctrl+Shift+T — that's VS Code's own "Reopen Closed
  // Editor" shortcut already; stepping on it wasn't worth the parallel to
  // Claude Code's binding. Command palette only.
  const reopenClosedSession = vscode.commands.registerCommand('rizo.reopenClosedSession', () => {
    ChatPanel.createOrShow(context);
    ChatPanel.currentPanel?.restoreLastDeleted();
  });
  // uri comes from the Explorer/editor-tab context menu VS Code invoked
  // this from (the clicked resource) — undefined if somehow run from the
  // command palette instead, where there's no "the file you right-clicked"
  // to fall back to, so that case just declines rather than guessing.
  const addFileToThread = vscode.commands.registerCommand('rizo.addFileToThread', (uri?: vscode.Uri) => {
    if (!uri) {
      vscode.window.showWarningMessage('Right-click a file in the Explorer or an editor tab to use this.');
      return;
    }
    ChatPanel.createOrShow(context);
    ChatPanel.currentPanel?.addFileToThread(uri.fsPath);
  });

  // uri/line/lineText come from TodoCodeLensProvider's own CodeLens
  // arguments (todoCodeLens.ts). Hidden from the command palette
  // (package.json's commandPalette menu entry, "when": "false") since
  // there's no "which TODO" to act on from there — but hiding a command
  // from the palette doesn't stop vscode.commands.executeCommand from
  // still reaching it (a keybinding, another extension, a stale palette
  // history entry), so it still needs its own guard, same as
  // addFileToThread's.
  const implementTodo = vscode.commands.registerCommand(
    'rizo.implementTodo',
    (uri?: vscode.Uri, line?: number, lineText?: string) => {
      if (!uri || line === undefined || lineText === undefined) {
        vscode.window.showWarningMessage('Click "Implement with Rizo" above a TODO/FIXME comment to use this.');
        return;
      }
      const relPath = vscode.workspace.asRelativePath(uri);
      const prompt = `Implement this TODO in ${relPath}:${line + 1}:\n\n${lineText.trim()}`;
      ChatPanel.createOrShow(context);
      ChatPanel.currentPanel?.prefillComposer(prompt);
    },
  );
  registerTodoCodeLens(context);

  context.subscriptions.push(openChat, changeApiKey, reopenClosedSession, addFileToThread, implementTodo);
}

export function deactivate() {}
