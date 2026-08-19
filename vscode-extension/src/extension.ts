// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';

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

  context.subscriptions.push(openChat, changeApiKey, reopenClosedSession);
}

export function deactivate() {}
