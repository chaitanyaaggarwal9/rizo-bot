# Contributing

Guide for working on Rizo (`vscode-extension/`) and its marketing site
(`website/`). Licensed Apache 2.0 + Commons Clause (see
[LICENSE](LICENSE)) — source-available, free to use and modify, resale
not permitted. Issues and pull requests are welcome; by opening one
you're contributing under that same license. For anything beyond a small
fix, open an issue first so we can agree on the approach before you put
time into an implementation.

## Coding standards

Read `vscode-extension/skills/` before making a change — those files
(Coding Discipline, Debugging Discipline, Git Hygiene, Test Discipline,
Security Hygiene, and the rest) are the actual standard this project
holds itself to, not just what Rizo loads into its own system prompt.
If you're touching code, they apply to you too.

## Rizo (`vscode-extension/`)

```bash
cd vscode-extension
npm install
npm run compile      # or `npm run watch` while iterating
```

Launch via VS Code's Run and Debug panel (F5) to open an Extension
Development Host with your changes loaded. `.vscode/launch.json` is
already configured — no setup needed beyond `npm install`.

**Before proposing a change:**
- Compile clean (`npm run compile`) — no TypeScript errors
- Run the test suite (`npm test`) — pure-logic modules (task
  classification, model/effort selection, destructive-command detection,
  struggle detection, pricing, thread storage) are all written to be
  testable outside the extension host (no direct `vscode` import at the
  module level)
- Manually verify in the Extension Development Host for anything
  touching the webview, approval dialogs, or file/terminal tools — those
  need the real host to test meaningfully

**Releasing to the Marketplace:**

Bump `version` in `vscode-extension/package.json`, move the relevant
[`CHANGELOG.md`](CHANGELOG.md) entries out of `[Unreleased]` into a new
dated section, commit, then tag and push:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` picks it up from there: compiles, runs
the test suite, checks the tag matches `package.json`'s version (refuses
to publish on a mismatch), packages, publishes to the Marketplace, and
attaches the `.vsix` to a GitHub Release. Needs a `VSCE_PAT` repo
secret — a Marketplace-scoped Personal Access Token from
[dev.azure.com](https://dev.azure.com), added under Settings → Secrets
and variables → Actions.

To package a `.vsix` locally without publishing (e.g. to test an install
before tagging a release):

```bash
cd vscode-extension
npx vsce package --allow-missing-repository
```

## Website (`website/`)

Static HTML/CSS/JS, no build step — see [website/README.md](website/README.md)
for local preview and deploy instructions.

## Before every push

Per Git Hygiene's rule 7: check whether your change invalidates anything
`README.md`, `CHANGELOG.md`, or `CONTRIBUTING.md` currently claims. Update
what's now wrong, create what's missing and needed, leave the rest alone —
don't touch a doc just to touch it.
