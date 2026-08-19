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

  context.subscriptions.push(openChat, changeApiKey);
}

export function deactivate() {}
