import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// Most modules here don't import 'vscode' at module level, so they're
// tested directly with no mock. The ones that do (chatPanel.ts, tools.ts,
// trustPrompts.ts, threadStore.ts) get test/vscodeStub.ts instead: just
// enough of the API for ChatPanel's constructor and getHtml() to run
// outside the real extension host. A full send/tool-call flow is still
// checked by hand with the CI-built .vsix.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    alias: {
      vscode: path.resolve(here, 'test/vscodeStub.ts'),
    },
  },
});
