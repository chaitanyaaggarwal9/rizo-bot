# Security model

Rizo is an AI agent that can read files, write files, run commands and
call MCP tools on your machine. This page explains what it does to keep
that safe. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What Rizo protects against

- A model that makes a mistake, or is talked into one by text it read
  (a README, an issue, a web page, an MCP result).
- A repository you open that tries to make Rizo do something on its own,
  for example through workspace settings or project notes.
- Secrets leaking to an AI provider or into chat history.
- A compromised dependency or release pipeline.

Rizo does not protect against code you choose to run yourself, or
commands and edits you approve.

## Workspace trust and settings

- Rizo is disabled in VS Code's Restricted Mode and in virtual
  workspaces. It only runs in folders you trust.
- Security settings are **user settings only** (application scope), so a
  repository's `.vscode/settings.json` can't change them:
  `rizo.permissions.autoApproveCommandPatterns`,
  `rizo.permissions.passEnvironmentVariables`, `rizo.mcp.servers`, and
  the inline edit and autocomplete models.

## Approvals

| Action | What happens |
|---|---|
| Read a file | Automatic, except files that usually hold secrets (`.env`, private keys, credentials), which ask every time |
| Search, list, navigate | Automatic; read-only and inside the workspace |
| Write or edit a file | Shows a diff and asks. "Always Allow (this project)" can skip this, except for protected paths |
| Protected paths | `.vscode`, `.git`, `.github`, `.rizo`, `.devcontainer`, `.husky`, `.npmrc`, `.yarnrc`, `.envrc`, `.gitmodules`, `.gitattributes` always ask, because writing them can turn on automation |
| Run a command | Asks. Patterns you list in `autoApproveCommandPatterns` must match the whole command and never cover chains, pipes, substitutions or redirects |
| Destructive commands | Always warn and ask: force-push, `reset --hard`, branch deletion, `rm -rf`, downloads piped into a shell, `bash -c`, `eval` and similar |
| MCP tool call | Asks every time, showing the arguments, unless you chose "always" for that one tool in that workspace |

A change approved after you pressed Stop is not applied.

## Boundaries

- Tools resolve paths with `realpath` and stay inside the workspace
  folders. Writes refuse to follow symlinks.
- A folder outside the workspace can be used only after you grant it,
  either through a prompt or by naming it in your own message. Grants
  can be reviewed with **Rizo: Manage Folder Access**. The whole
  disk, your entire home folder, credential folders such as `~/.ssh`,
  and system folders can't be granted.
- Undo only restores files inside the allowed folders, rechecked at undo
  time.

## Secrets

- API keys are stored in VS Code's SecretStorage (your OS keychain),
  never in settings or files.
- Commands and local MCP servers get your environment **minus variables
  that usually hold credentials** (names with `TOKEN`, `SECRET`,
  `PASSWORD`, `API_KEY`, and prefixes such as `AWS_`, `AZURE_`, `GH_`).
  You can pass specific ones with `rizo.permissions.passEnvironmentVariables`.
- Secrets in command output, search results and MCP results are redacted
  before the model sees them or they are saved in history.
- Files that usually hold secrets are never searched or sent for
  autocomplete, and inline edit asks before sending one.

## Untrusted content

- `.rizo/instructions.md` is used only after you approve it, and any
  change to the file (including from `git pull`) asks again. It is shown
  to the model as repository content, not as instructions that outrank
  you.
- MCP results are labelled as untrusted, capped in size and redacted.
- Proposed edits are scanned for dangerous patterns (`eval`, disabled TLS
  checks, hardcoded secrets, unsafe deserialization) and flagged in the
  approval dialog.

## MCP servers

- Servers come only from the `rizo.mcp.servers` user setting; opening a
  repository can't start one.
- Local servers start without a shell, in their own process group, which
  is killed when Rizo stops them.
- Remote servers must use https (plain http only to localhost). URLs with
  credentials are refused, and redirects are not followed.
- MCP tools are never offered in Plan mode, and a server's claim that a
  tool is read-only is ignored.

## Rizo Lang compiler

- Rizo runs only the project's own compiler (`node_modules/rizolang`,
  found from the file's folder up to the workspace root, never above),
  and only after you allow it for the project. Allowing is remembered per
  compiler path and version, so an update asks again.
- The package must be named `rizolang` and its bin script must stay
  inside the package, even through symlinks.
- Only `rizolang audit <file> --json` runs. It compiles and reviews a copy
  of the file in a private temporary folder and writes nothing to your
  project. Credential variables are withheld, and it has a 15-second limit.
- Rizo never installs the compiler; it only suggests the command.

## The chat view

The webview has a strict Content Security Policy (no remote content, only
scripts with a per-load nonce), checks the origin of every message, and
only shows images from safe data URLs. The extension validates every
message the webview sends.

## Supply chain and releases

- Dependencies are pinned to exact versions, installed with
  `npm ci` and install scripts disabled, and checked with
  `npm audit signatures` in CI.
- GitHub Actions are pinned to commit SHAs. CodeQL, dependency review and
  a malware scan run on every pull request.
- Marketplace releases are published from a tag by GitHub Actions through
  Visual Studio Marketplace Trusted Publishing (OIDC). There is no stored
  publishing token.
