// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import { ChatPanel } from './ui/chatPanel';
import { getMcpManager } from './mcp/mcpManager';
import { inlineEdit } from './editor/inlineEdit';
import { registerAutocomplete } from './editor/autocomplete';
import { registerTodoCodeLens } from './ui/todoCodeLens';
import { manageFolderAccess } from './ui/trustPrompts';
import { CONNECTED_PROVIDERS } from './ui/connectedProviders';
import { RizoCompletionProvider } from './editor/autocomplete';
import { overrideOpenRouterUrlForTests } from './api/openrouter';

// What the end-to-end tests (test/e2e) can reach. Returned only when VS
// Code runs the extension in test mode, never in a normal install.
export interface RizoTestApi {
  context: vscode.ExtensionContext;
  setOpenRouterUrl(url: string | undefined): void;
  chatPanel(): ChatPanel | undefined;
  mcp(): ReturnType<typeof getMcpManager>;
  completionProvider(): RizoCompletionProvider;
}

export function activate(context: vscode.ExtensionContext): RizoTestApi | undefined {
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

  // Lists folders outside the workspace that chats were allowed to use
  // (trustPrompts.ts) and revokes the ones the user picks.
  const manageFolderAccessCmd = vscode.commands.registerCommand('rizo.manageFolderAccess', () =>
    manageFolderAccess(context),
  );

  // Your own cloud accounts (Azure AI Foundry, Amazon Bedrock), with your
  // own keys: rizo.connectAzure / rizo.disconnectAzure, and the same for
  // bedrock.
  const connectCommands = Object.values(CONNECTED_PROVIDERS).flatMap((p) => {
    const name = p.id.charAt(0).toUpperCase() + p.id.slice(1);
    return [
      vscode.commands.registerCommand(`rizo.connect${name}`, async () => {
        await p.connect(context);
        ChatPanel.currentPanel?.refreshProviders();
      }),
      vscode.commands.registerCommand(`rizo.disconnect${name}`, async () => {
        await p.disconnect(context);
        ChatPanel.currentPanel?.refreshProviders();
      }),
    ];
  });

  // MCP servers from the user's settings (mcp/mcpManager.ts).
  const mcpCommands = [
    vscode.commands.registerCommand('rizo.addMcpServer', () => getMcpManager(context).addServer()),
    vscode.commands.registerCommand('rizo.showMcpServers', () => getMcpManager(context).showServers()),
  ];

  // Editor features: inline edit and autocomplete (editor/).
  const editorFeatures = [
    vscode.commands.registerCommand('rizo.inlineEdit', (args?: { instruction?: unknown }) => inlineEdit(context, args)),
    vscode.commands.registerCommand('rizo.toggleAutocomplete', async () => {
      const config = vscode.workspace.getConfiguration('rizo');
      const next = !config.get<boolean>('autocomplete.enabled', false);
      await config.update('autocomplete.enabled', next, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        next ? 'Rizo autocomplete is on. Each suggestion is a small paid request to your autocomplete model.' : 'Rizo autocomplete is off.',
      );
    }),
    registerAutocomplete(context),
  ];

  context.subscriptions.push(
    ...editorFeatures,
    ...connectCommands,
    ...mcpCommands,
    openChat,
    changeApiKey,
    reopenClosedSession,
    addFileToThread,
    implementTodo,
    manageFolderAccessCmd,
  );

  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    context,
    setOpenRouterUrl: overrideOpenRouterUrlForTests,
    chatPanel: () => ChatPanel.currentPanel,
    mcp: () => getMcpManager(context),
    completionProvider: () => new RizoCompletionProvider(context),
  };
}

export function deactivate() {}
