import { defineConfig } from 'vitest/config';

// Covers only the modules that don't import 'vscode' at module level
// (see CONTRIBUTING.md) — task classification, model/effort selection,
// destructive-command detection, dangerous-pattern scanning, secret
// redaction, pricing, slash commands, struggle detection. Anything that
// touches the extension host directly (chatPanel.ts, tools.ts,
// threadStore.ts, usageStore.ts, extension.ts, todoCodeLens.ts) is
// exercised manually in the Extension Development Host instead — a real
// vscode API mock is a bigger investment than this project's size
// currently justifies.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
