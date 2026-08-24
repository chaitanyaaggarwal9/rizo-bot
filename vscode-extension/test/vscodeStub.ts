// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Minimal stand-in for the real 'vscode' module — aliased in
// vitest.config.mts so chatPanel.ts (and everything it imports) can be
// loaded outside the actual extension host. Just enough surface for
// ChatPanel's constructor and getHtml() to run; nothing here needs to
// behave correctly beyond that, since chatPanel.test.ts only exercises
// panel construction and the generated webview markup, never a real
// send/tool-call flow.
const fakeConfig = { get: (_key: string, def: unknown) => def, update: async () => {} };

export const workspace = {
  getConfiguration: () => fakeConfig,
  workspaceFolders: undefined,
  onDidChangeConfiguration: () => ({ dispose() {} }),
  createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }),
  findFiles: async () => [],
};

// The fake webview object stores whatever ChatPanel assigns to .html
// on a plain property (real vscode.Webview only exposes it as a
// getter/setter pair backed by IPC to the actual renderer) — tests read
// it straight back off this object after ChatPanel.createOrShow runs.
function fakeWebviewPanel() {
  return {
    webview: {
      html: '',
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose() {} }),
      asWebviewUri: (uri: { toString: () => string }) => ({ toString: () => 'vscode-webview://fake/' + uri.toString() }),
      cspSource: 'vscode-webview://fake',
    },
    onDidDispose: () => ({ dispose() {} }),
    reveal: () => {},
    dispose: () => {},
    iconPath: undefined as unknown,
  };
}

export const window = {
  showInputBox: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showOpenDialog: async () => undefined,
  createWebviewPanel: () => fakeWebviewPanel(),
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
};

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose() {} }),
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => 'file://' + p, scheme: 'file', path: p }),
};

// Real vscode.Position is immutable and has line/character readonly
// properties plus comparison helpers — this only implements the shape
// tools.ts's findSymbolPosition actually constructs and tests actually
// read (line/character), not the full API.
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export const ViewColumn = { Beside: 2, Active: -1 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
