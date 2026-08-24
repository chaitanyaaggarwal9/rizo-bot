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
  // Not bound to Cmd/Ctrl+Shift+T — that's already VS Code's "Reopen
  // Closed Editor" shortcut. Command palette only.
  const reopenClosedSession = vscode.commands.registerCommand('rizo.reopenClosedSession', () => {
    ChatPanel.createOrShow(context);
    ChatPanel.currentPanel?.restoreLastDeleted();
  });
  // uri is the clicked resource from the Explorer/editor-tab context menu
  // — undefined from the command palette, where there's nothing to fall
  // back to, so it declines.
  const addFileToThread = vscode.commands.registerCommand('rizo.addFileToThread', (uri?: vscode.Uri) => {
    if (!uri) {
      vscode.window.showWarningMessage('Right-click a file in the Explorer or an editor tab to use this.');
      return;
    }
    ChatPanel.createOrShow(context);
    ChatPanel.currentPanel?.addFileToThread(uri.fsPath);
  });

  // uri/line/lineText come from TodoCodeLensProvider's CodeLens arguments.
  // Hidden from the command palette (no "which TODO" to act on there),
  // but that doesn't stop executeCommand from reaching it directly —
  // still needs its own guard.
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
