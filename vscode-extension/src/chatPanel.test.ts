// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatPanel } from './chatPanel';

// The chat view used to be one large TypeScript template literal, and a
// real bug shipped from that: `\n` written inside it was consumed by the
// outer literal, corrupting the nested script so the whole panel failed
// to load. The view now lives in media/chat.html, chat.css and chat.js,
// and these tests check the pieces still fit together.

const extensionRoot = path.resolve(__dirname, '..');

describe('chat view', () => {
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
      extensionPath: extensionRoot,
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      globalState: { get: (_key: string, def: unknown) => def, update: async () => {} },
      workspaceState: { get: (_key: string, def: unknown) => def, update: async () => {} },
      globalStorageUri: { fsPath: tmpDir },
    } as any;
  }

  function renderHtml(): string {
    ChatPanel.createOrShow(createFakeContext());
    return (ChatPanel as unknown as { currentPanel: { panel: { webview: { html: string } } } }).currentPanel.panel.webview.html;
  }

  it('ships a chat script that is syntactically valid JavaScript', () => {
    const script = fs.readFileSync(path.join(extensionRoot, 'media', 'chat.js'), 'utf-8');
    // Parses without executing (the script calls acquireVsCodeApi(), which
    // only exists inside a real webview).
    expect(() => new Function(script)).not.toThrow();
  });

  it('fills in every placeholder', () => {
    const html = renderHtml();
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  it('loads the stylesheet and script from the extension, with a matching nonce', () => {
    const html = renderHtml();
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}" src="vscode-webview://fake/`);
    expect(html).toMatch(/<link rel="stylesheet" href="vscode-webview:\/\/fake\/file:\/\/[^"]*media[\\/]chat\.css">/);
    // The only inline <script> is the JSON data block, which never runs.
    const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || [];
    expect(inlineScripts).toEqual(['<script type="application/json" id="provider-catalog">']);
  });

  it('embeds the provider catalog as JSON that parses and cannot close its element', () => {
    const html = renderHtml();
    const json = /<script type="application\/json" id="provider-catalog">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(json).toBeDefined();
    expect(json).not.toContain('<');
    const catalog = JSON.parse(json as string);
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog[0]).toHaveProperty('variants');
  });

  it('uses a different random nonce on each render', () => {
    const first = /nonce-([0-9a-f]+)/.exec(renderHtml())?.[1];
    (ChatPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    const second = /nonce-([0-9a-f]+)/.exec(renderHtml())?.[1];
    expect(first).not.toBe(second);
  });

  it('includes the mascot image as a webview-served URI, not an inlined base64 data: URI', () => {
    const html = renderHtml();
    expect(html).not.toContain('data:image/png;base64,');
    expect(html).toContain('vscode-webview://');
  });
});
