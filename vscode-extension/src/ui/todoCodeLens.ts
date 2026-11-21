// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';

// Matches TODO/FIXME regardless of comment style (//, #, <!--, /*, --) by
// scanning raw line text, not a real per-language comment parser. A
// string literal containing "TODO:" is a false positive this accepts in
// exchange for not needing a parser per language grammar.
const TODO_PATTERN = /\b(TODO|FIXME)\b:?\s*(.*)$/i;

export class TodoCodeLensProvider implements vscode.CodeLensProvider {
  // VS Code only re-queries provideCodeLenses for an open, unedited
  // document when this fires — without it, toggling
  // rizo.todoCodeLens.enabled off left stale lenses visible until
  // edit/reopen.
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('rizo').get<boolean>('todoCodeLens.enabled', true)) return [];

    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const match = TODO_PATTERN.exec(line.text);
      if (!match) continue;
      lenses.push(
        new vscode.CodeLens(line.range, {
          title: 'Implement with Rizo',
          command: 'rizo.implementTodo',
          arguments: [document.uri, i, line.text],
        }),
      );
    }
    return lenses;
  }
}

export function registerTodoCodeLens(context: vscode.ExtensionContext): vscode.Disposable {
  const provider = new TodoCodeLensProvider();
  const providerDisposable = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider);
  const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('rizo.todoCodeLens.enabled')) provider.refresh();
  });
  context.subscriptions.push(providerDisposable, configDisposable);
  return providerDisposable;
}
