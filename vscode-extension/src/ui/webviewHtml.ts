// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PROVIDER_ORDER, PROVIDERS } from '../models/providers';

// Cryptographically random, so a script injected into the chat view can't
// guess it and satisfy the Content-Security-Policy.
export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// media/chat.html, read once per session (it only changes with a new
// extension version).
let chatTemplateCache: string | undefined;
function chatTemplate(extensionPath: string): string {
  chatTemplateCache ??= fs.readFileSync(path.join(extensionPath, 'media', 'chat.html'), 'utf-8');
  return chatTemplateCache;
}

// The chat view lives in media/chat.html, chat.css and chat.js (plain
// files, so the script is ordinary JavaScript rather than text inside a
// TypeScript template literal, where escapes behave differently). Only
// per-render values are filled in here.
export function buildChatHtml(webview: vscode.Webview, extensionPath: string): string {
  const fileUri = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, ...parts))).toString();
  // Trimmed view of providers.ts handed to the webview once, so the
  // picker grid renders from the same catalog isValidProviderModel
  // enforces — no risk of drift.
  const providerCatalog = PROVIDER_ORDER.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    variants: PROVIDERS[id].variants.map((v) => ({
      id: v.id,
      label: v.label,
      tagline: v.tagline,
      reasoning: v.reasoning !== false,
    })),
  }));
  const values: Record<string, string> = {
    nonce: getNonce(),
    cspSource: webview.cspSource,
    chatCssUri: fileUri('media', 'chat.css'),
    chatJsUri: fileUri('media', 'chat.js'),
    // asWebviewUri, not a base64 data: URI — inlining a 444KB image on
    // every render is what VS Code's webview guide warns against.
    mascotUri: fileUri('assets', 'mascot.png'),
    // Embedded in a <script type="application/json"> element: "<" is
    // escaped so the data can never close the element early.
    providerCatalogJson: JSON.stringify(providerCatalog).replace(/</g, '\\u003c'),
  };
  // A replacer function, so "$" in a value is inserted literally.
  return chatTemplate(extensionPath).replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : placeholder,
  );
}
