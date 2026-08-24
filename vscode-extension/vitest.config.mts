import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// Most modules here don't import 'vscode' at module level (see
// CONTRIBUTING.md) — task classification, model/effort selection,
// destructive-command detection, dangerous-pattern scanning, secret
// redaction, pricing, slash commands, struggle detection, and the
// OpenRouter streaming client. Those are tested directly, no mock
// needed. chatPanel.ts is the one exception: it does import 'vscode',
// but the actual generated webview markup — a giant string built from
// one outer template literal, embedding the entire chat UI's own JS as
// nested source text — is exactly the kind of thing tsc's type-checking
// can't validate (see chatPanel.test.ts's own comment for why that's
// not hypothetical: a real shipped bug slipped through this exact gap).
// test/vscodeStub.ts provides just enough of the API surface for
// ChatPanel's constructor and getHtml() to run outside the real
// extension host — nothing beyond that; a full send/tool-call flow is
// still exercised manually in the Extension Development Host.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    alias: {
      vscode: path.resolve(here, 'test/vscodeStub.ts'),
    },
  },
});
