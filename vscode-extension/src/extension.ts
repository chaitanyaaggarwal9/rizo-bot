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

  // line/lineText come from TodoCodeLensProvider's own CodeLens arguments
  // (todoCodeLens.ts) — not reachable from the command palette on its own,
  // since there's no "which TODO" to act on without them.
  const implementTodo = vscode.commands.registerCommand(
    'rizo.implementTodo',
    (uri: vscode.Uri, line: number, lineText: string) => {
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
