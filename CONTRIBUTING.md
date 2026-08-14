# Contributing

Guide for working on this repo — the Express backend/CLI (root) and the Rizo
VS Code extension (`vscode-extension/`). Licensed Apache 2.0 (see
[LICENSE](LICENSE)) — issues and pull requests are welcome. For anything
beyond a small fix, open an issue first so we can agree on the approach
before you put time into an implementation.

## Coding standards

Read `skills/` before making a change — those files (Coding Discipline,
Debugging Discipline, Git Hygiene, Backend API Taste, Test Discipline) are
the actual standard this project holds itself to, not just what Rizo loads
into its own system prompt. If you're touching code, they apply to you too.

## Backend (root)

```bash
npm install
cp .env.example .env   # add your OPENROUTER_API_KEY
node server.js
```

Browser at `http://localhost:3000`, or `npm run chat` for the CLI. No test
suite yet — verify manually against the flows in the main README before
pushing a change here.

## Rizo (vscode-extension/)

```bash
cd vscode-extension
npm install
npm run compile      # or `npm run watch` while iterating
```

Launch via VS Code's Run and Debug panel (F5) to open an Extension
Development Host with your changes loaded. `.vscode/launch.json` is already
configured — no setup needed beyond `npm install`.

**Before proposing a change:**
- Compile clean (`npm run compile`) — no TypeScript errors
- For anything with pure logic (task classification, skill selection,
  destructive-command detection, pricing, thread storage) — these are all
  written to be testable outside the extension host (no direct `vscode`
  import at the module level). Run a quick headless check with `node -e`
  against the compiled `out/*.js` rather than only testing by hand in the
  Extension Development Host.
- Manually verify in the Extension Development Host for anything touching
  the webview, approval dialogs, or file/terminal tools — those need the
  real host to test meaningfully.

**Packaging a `.vsix` to distribute:**

```bash
npx vsce package --allow-missing-repository
```

Bump the `version` in `package.json` first if the change is user-facing,
and add an entry to [`CHANGELOG.md`](CHANGELOG.md).

## Before every push

Per Git Hygiene's rule 7: check whether your change invalidates anything
`README.md`, `CHANGELOG.md`, or `CONTRIBUTING.md` currently claims. Update
what's now wrong, create what's missing and needed, leave the rest alone —
don't touch a doc just to touch it.
