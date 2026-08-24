// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatPanel } from './chatPanel';

// getHtml() builds the entire webview — including the whole chat UI's
// own JavaScript — as one large outer TypeScript template literal. tsc
// only ever validates that as a single string; it cannot see that the
// nested JS it produces is itself a real, separately-parsed program.
//
// A real bug shipped from exactly that gap: several `.split('\n')`
// calls inside the outer literal were written with a single backslash,
// so `\n` got consumed by the OUTER literal's own escape processing
// into a real newline character, corrupting the nested script's source
// the moment the browser parsed it — "Uncaught SyntaxError: Failed to
// execute 'write' on 'Document'" the whole panel failed to load with,
// caught only by extracting the real rendered script and running
// `node --check` against it by hand. This test automates exactly that
// check so the same mistake can't silently ship again.
function extractWebviewScript(html: string): string {
  const match = /<script nonce="[^"]*">([\s\S]*?)<\/script>\s*<\/body>/.exec(html);
  if (!match) throw new Error('Could not find the webview\'s <script> block in the generated HTML.');
  return match[1];
}

describe('ChatPanel.getHtml()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-chatpanel-test-'));
    (ChatPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFakeContext() {
    return {
      extensionPath: path.resolve(__dirname, '..'),
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      globalState: { get: (_key: string, def: unknown) => def, update: async () => {} },
      workspaceState: { get: (_key: string, def: unknown) => def, update: async () => {} },
      globalStorageUri: { fsPath: tmpDir },
    } as any;
  }

  it('produces a webview script that is syntactically valid JavaScript', () => {
    const context = createFakeContext();
    ChatPanel.createOrShow(context);
    const html = (ChatPanel as unknown as { currentPanel: { panel: { webview: { html: string } } } }).currentPanel.panel.webview.html;
    const script = extractWebviewScript(html);

    // Parses the function body without executing it (the script has
    // top-level side effects like acquireVsCodeApi() that only make
    // sense inside a real webview) — a SyntaxError here means the
    // generated script is genuinely broken, exactly the class of bug
    // this test exists to catch.
    expect(() => new Function(script)).not.toThrow();
  });

  it('includes the mascot image as a webview-served URI, not an inlined base64 data: URI', () => {
    // Regression guard for the ~590KB-of-text-per-render mascot inlining
    // this was fixed alongside (see CHANGELOG) — not the crash itself,
    // but the same "avoid what the webview guide already warns against"
    // category, found while investigating it.
    const context = createFakeContext();
    ChatPanel.createOrShow(context);
    const html = (ChatPanel as unknown as { currentPanel: { panel: { webview: { html: string } } } }).currentPanel.panel.webview.html;
    expect(html).not.toContain('data:image/png;base64,');
    expect(html).toContain('vscode-webview://');
  });
});
