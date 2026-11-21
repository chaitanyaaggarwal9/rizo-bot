// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { destructiveReasons } from '../safety/destructiveCommands';
import { capOutput, filterEnvironment } from '../safety/commandPolicy';
import { scanDangerousPatterns } from '../safety/dangerousPatterns';
import { redactSecrets } from '../safety/outputRedaction';
import { hasShellControl, isProtectedPath, isSecretFile, matchesAutoApprove } from '../safety/permissions';
import {
  looksBinary,
  makePrivateTempDir,
  readFileHead,
  replaceExactlyOnce,
  resolveWithinRoots,
  safeWriteFile,
  sliceForReading,
} from '../safety/pathPolicy';
import { listThreads, loadThread } from '../storage/threadStore';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file in the current workspace. Path is relative to the workspace root. Large files come back in parts: use start_line/end_line (1-based, inclusive) to read a specific range or to continue where the previous read stopped.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          start_line: { type: 'integer', description: 'Optional first line to return (1-based)' },
          end_line: { type: 'integer', description: 'Optional last line to return (inclusive)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file, or fully overwrite an existing one, with the given content. Requires user approval: a diff is shown before anything is written to disk. Prefer edit_file for changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make a surgical edit to an existing file by replacing one exact occurrence of old_string with new_string. Prefer this over write_file for existing files: touch only what changed. Requires user approval before anything is written.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          old_string: { type: 'string', description: 'Exact text to find (must appear exactly once in the file)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root: git, npm, tests, build scripts, etc. Requires user approval before running. Commands that look destructive (force-push, hard reset, branch deletion, rm -rf) or that hide what they actually run (piping a remote download into a shell, `bash -c "..."`, `eval`) get an extra emphasized warning, per Git Hygiene\'s rule that hard-to-reverse or opaque operations need the same confirm-first habit as any other risky action.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          description: {
            type: 'string',
            description:
              'A short (5-10 word), imperative-mood, present-tense summary of what this command does and why, e.g. "Check whether the release tag matches package.json", NOT a restatement of the command text itself. Shown as the line in the live transcript; the exact command is available on expand.',
          },
        },
        required: ['command', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_past_work',
      description:
        "Search every OTHER chat thread in this workspace (not this one, that's already in your context) for prior work touching a specific file: which threads touched it, when, and what was being asked at the time. Useful before a risky change, or when the user asks something like \"didn't we already fix this?\" Deterministic: built from what read_file/write_file/edit_file actually touched in each past turn, not an AI guess at relevance.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path to search for' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_definition',
      description:
        "Jump to where a symbol (function, class, variable, type) is actually defined. Uses the workspace's own language server (same engine as VS Code's \"Go to Definition\"), not a text search, so it resolves through imports and re-exports correctly. Faster and more accurate than grepping for the declaration by hand.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to a file that references the symbol' },
          symbol: { type: 'string', description: 'The exact symbol name to look up (case-sensitive)' },
        },
        required: ['path', 'symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        "Find every place a symbol is used across the whole workspace, same engine as VS Code's \"Find All References\", not a text search, so it won't miss a usage or match an unrelated same-named symbol elsewhere. Use before renaming or changing a function's signature to see everything that would break.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to a file that defines or references the symbol' },
          symbol: { type: 'string', description: 'The exact symbol name to look up (case-sensitive)' },
        },
        required: ['path', 'symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_hierarchy',
      description:
        "For a function specifically, who calls it or what it calls (one level, not a text search). \"incoming\" answers \"what breaks if I change this function's behavior\"; \"outgoing\" answers \"what does this function actually depend on\". Falls back to find_references-like behavior if the language server can't build a call hierarchy for this symbol (some languages/positions don't support it).",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to a file that defines the function' },
          symbol: { type: 'string', description: 'The exact function name to look up (case-sensitive)' },
          direction: { type: 'string', enum: ['incoming', 'outgoing'], description: '"incoming" = callers of this function, "outgoing" = functions this one calls' },
        },
        required: ['path', 'symbol', 'direction'],
      },
    },
  },
];

// For the live tool-call transcript's two-tier card: label is the short
// tool-type tag ("Bash", "Read", ...), title is the one-line summary
// always visible, detail is the exact command/args shown only when
// expanded — a required "description" parameter separate from "command",
// so the visible line is intent, not syntax. Best-effort: a malformed
// args string falls back to the bare tool name rather than throwing.
export interface ToolCallSummary {
  label: string;
  title: string;
  detail?: string;
  // diffOld/diffNew: present only for write_file/edit_file, and only when
  // small enough to render inline (DIFF_MAX_CHARS below). Rendered as a
  // real +/- diff instead of flat IN/OUT text — showApprovalDiff's native
  // vscode.diff view is gone by the time anyone scrolls back.
  diffOld?: string;
  diffNew?: string;
  // true for a write_file call creating a file that doesn't exist yet —
  // diffOld is meaningless there (nothing to diff against), so the card
  // renders diffNew as all-new content instead of a diff.
  isNewFile?: boolean;
}

// Above this, an inline line-diff isn't worth the O(n*m) LCS cost or DOM
// size — showApprovalDiff's vscode.diff view already showed the change
// at approval time. Falls back to no diff above this.
const DIFF_MAX_CHARS = 20000;

// A truncated write_file/edit_file call fails JSON.parse entirely, but
// "path" is a short field declared before the often-huge content field,
// so it's usually still intact in the raw string. Regex-recovers just
// that field rather than showing "(unknown path)" for a call whose
// target file is actually known.
function extractPathFallback(argsJson: string): string | undefined {
  const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argsJson);
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
}

export function summarizeToolCall(name: string, argsJson: string, extraRoots: string[] = []): ToolCallSummary {
  let args: any = {};
  try {
    args = JSON.parse(argsJson);
  } catch {
    /* best effort — extractPathFallback below still tries for read/write/edit */
  }
  const path = args.path ?? extractPathFallback(argsJson);
  switch (name) {
    case 'read_file':
      return { label: 'Read', title: path ?? '(unknown path)' };
    case 'write_file': {
      // Best-effort — this only decides what to show in the transcript,
      // so a read failure here just means "no diff shown." executeTool's
      // own resolveSafePath is what actually enforces the trust boundary.
      let existing: string | undefined;
      try {
        const resolved = resolveSafePath(path, extraRoots);
        if (fs.existsSync(resolved) && fs.statSync(resolved).size <= DIFF_MAX_CHARS * 4) existing = currentContent(resolved);
      } catch {
        /* unresolvable path — fall through with no diff */
      }
      const newContent: string | undefined = typeof args.content === 'string' ? args.content : undefined;
      const tooBig = (existing?.length ?? 0) > DIFF_MAX_CHARS || (newContent?.length ?? 0) > DIFF_MAX_CHARS;
      return tooBig || newContent === undefined
        ? { label: 'Write', title: path ?? '(unknown path)' }
        : { label: 'Write', title: path ?? '(unknown path)', diffOld: existing, diffNew: newContent, isNewFile: existing === undefined };
    }
    case 'edit_file': {
      const oldString: string | undefined = args.old_string;
      const newString: string | undefined = args.new_string;
      const tooBig = (oldString?.length ?? 0) > DIFF_MAX_CHARS || (newString?.length ?? 0) > DIFF_MAX_CHARS;
      return tooBig || oldString === undefined || newString === undefined
        ? { label: 'Edit', title: path ?? '(unknown path)' }
        : { label: 'Edit', title: path ?? '(unknown path)', diffOld: oldString, diffNew: newString };
    }
    case 'run_command':
      // description is required, but older replayed history (or a
      // noncompliant model) may not have one — falls back to showing the
      // command itself as the title.
      return args.description
        ? { label: 'Bash', title: args.description, detail: args.command ?? '(unknown command)' }
        : { label: 'Bash', title: args.command ?? '(unknown command)' };
    default:
      return { label: name, title: name };
  }
}

// The expanded-detail cap — generous, since this only renders once you
// click to expand a card, not on every line by default. Still capped:
// read_file can return an entire file, run_command's stdout can be large,
// and this ends up in the DOM either way.
const RESULT_DETAIL_MAX_CHARS = 4000;

export function summarizeToolResult(result: string): string {
  return result.length <= RESULT_DETAIL_MAX_CHARS
    ? result
    : result.slice(0, RESULT_DETAIL_MAX_CHARS) + '\n…(truncated)';
}

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open. Open a folder to let the agent read/edit files.');
  }
  return folders[0].uri.fsPath;
}

// Every open workspace folder's real path, not just the first — a
// multi-root workspace is the same deliberate trust decision opening one
// folder always was, so every folder should be usable by read/write/
// edit, not just whichever VS Code lists first. Only resolveSafePath
// needs this — run_command's cwd (getWorkspaceRoot above) still means
// the primary folder, since a shell command runs in one directory.
function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open. Open a folder to let the agent read/edit files.');
  }
  return folders.map((f) => fs.realpathSync(f.uri.fsPath));
}

// Resolves a model-supplied path and refuses anything that escapes every
// open workspace folder or explicitly-granted extra root — path
// traversal, an absolute path outside all of them, and a symlink that
// lives inside one but points outside it. The string check alone
// (path.resolve + startsWith) catches "../.." but not a symlink:
// fs.readFileSync/writeFileSync follow symlinks at the OS level, so a
// path that looks allowed can silently read/write elsewhere. realpathSync
// resolves the actual target; walks up to the nearest existing ancestor
// first since a new file has no realpath of its own yet.
//
// extraRoots (default none): folders outside the workspace that the user
// explicitly allowed for this chat in this workspace (trustPrompts.ts's
// requestFolderGrants). Never taken from a model's tool-call arguments.
function resolveSafePath(relativePath: string, extraRoots: string[] = []): string {
  const roots = [...getWorkspaceRoots()];
  for (const r of extraRoots) {
    try {
      roots.push(fs.realpathSync(r));
    } catch {
      /* a granted folder that no longer exists just isn't usable */
    }
  }
  return resolveWithinRoots(relativePath, roots);
}

// The file's true current content — the live editor buffer if one's open
// (even unsaved, since that's the real content), otherwise disk.
// Read-only: never writes. Deliberately doesn't force-save a dirty editor
// first — that would let a Reject on the approval dialog fail to undo an
// unrelated autosave, permanently writing whatever draft was open
// regardless of the user's answer. Reading the live buffer sidesteps
// that: nothing touches disk until an approved write.
function currentContent(filePath: string): string {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
  return doc ? doc.getText() : fs.readFileSync(filePath, 'utf-8');
}

// Per-workspace "don't ask me again" flags. Deliberately NOT offered for
// destructive commands (see approveCommand) — that warning only means
// something if it can't be permanently silenced.
const ALWAYS_ALLOW_EDITS_KEY = 'rizo.alwaysAllowFileEdits';
const ALWAYS_ALLOW_COMMANDS_KEY = 'rizo.alwaysAllowCommands';

// Shows a native VS Code diff view, then a modal approve/reject prompt.
// Nothing is written to disk here — callers only proceed if the return
// value is true.
//
// scanTarget is separate from oldContent/newContent: just the part the
// model actually wrote, not a full diff — so the security scan below
// doesn't re-flag pre-existing code elsewhere in a file being overwritten.
async function showApprovalDiff(
  context: vscode.ExtensionContext,
  relativePath: string,
  oldContent: string,
  newContent: string,
  isNew: boolean,
  scanTarget: string,
): Promise<boolean> {
  const matches = scanDangerousPatterns(scanTarget);
  // Editor, git, CI and Rizo config files can turn on auto-approval or
  // run code on their own, so they always ask, even with Always Allow on.
  const isProtected = isProtectedPath(relativePath);

  if (!isProtected && context.workspaceState.get(ALWAYS_ALLOW_EDITS_KEY)) {
    // Always Allow skips the dialog entirely, but a dangerous-pattern match
    // still deserves to be seen — fire a non-blocking toast instead of
    // going completely dark for a workspace that's already flipped this on.
    if (matches.length) {
      vscode.window.showWarningMessage(
        `⚠️ ${relativePath} (auto-approved): ${matches.map((m) => m.description).join('; ')}`,
      );
    }
    return true;
  }

  // A private, unpredictable folder (0700) for the before/after files, so
  // other users on the machine can't read them or pre-plant a symlink.
  const tmpDir = makePrivateTempDir();
  const base = path.basename(relativePath) || 'file';
  const oldTmp = path.join(tmpDir, `before-${base}`);
  const newTmp = path.join(tmpDir, `after-${base}`);
  fs.writeFileSync(oldTmp, oldContent, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(newTmp, newContent, { mode: 0o600, flag: 'wx' });

  const title = isNew ? `New file: ${relativePath}` : `Edit: ${relativePath}`;
  try {
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(oldTmp), vscode.Uri.file(newTmp), title);

    const warningPrefix = matches.length
      ? `⚠️ Patterns worth a second look:\n${matches.map((m) => `• ${m.description}`).join('\n')}\n\n`
      : '';
    const showDialog = matches.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const protectedNote = isProtected
      ? 'This file controls editor, git, CI or Rizo settings, so changes to it always ask.\n\n'
      : '';
    const choice = await showDialog(
      `${warningPrefix}${protectedNote}Apply this change to ${relativePath}?`,
      { modal: true },
      'Approve',
      ...(isProtected ? [] : ['Always Allow (this project)']),
      'Reject',
    );
    if (choice === 'Always Allow (this project)') {
      await context.workspaceState.update(ALWAYS_ALLOW_EDITS_KEY, true);
      return true;
    }
    return choice === 'Approve';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

// Applies an approved change. If the file is open in an editor, the edit
// goes through the editor and is saved, so the editor and the disk don't
// end up with different text (the approval diff was built from the
// editor's text, unsaved changes included). Otherwise it's written
// directly with safeWriteFile (no symlink following).
async function applyFileContent(filePath: string, newContent: string): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, fullRange, newContent);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the edit.');
    if (!(await doc.save())) throw new Error('VS Code could not save the file.');
    return;
  }
  safeWriteFile(filePath, newContent);
}

// Read before the approval dialog and again after it: if the file changed
// while the user was deciding, applying the old diff would silently throw
// away whatever changed it.
function changedSince(filePath: string, before: string | undefined): boolean {
  const exists = fs.existsSync(filePath);
  if (before === undefined) return exists;
  return !exists || currentContent(filePath) !== before;
}

// Files that usually hold secrets (.env, private keys, credentials) are
// read only with the user's OK, every time: what Rizo reads is sent to the
// AI provider.
async function approveSecretRead(relativePath: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Rizo wants to read ${relativePath}, which usually holds secrets such as API keys or passwords.`,
    { modal: true, detail: 'Its contents would be sent to the AI provider for this chat. Allow this one read?' },
    'Allow this read',
  );
  return choice === 'Allow this read';
}

const READ_MAX_FILE_BYTES = 20 * 1024 * 1024;

// rizo.permissions.autoApproveCommandPatterns. The setting is
// application-scoped (package.json), so a repository's own
// .vscode/settings.json can't set it. matchesAutoApprove anchors each
// pattern to the whole command and never approves chained, piped,
// substituted or redirected commands.
function isAutoApproved(command: string): boolean {
  const patterns = vscode.workspace
    .getConfiguration('rizo')
    .get<string[]>('permissions.autoApproveCommandPatterns', []);
  return matchesAutoApprove(command, Array.isArray(patterns) ? patterns : []);
}

async function approveCommand(context: vscode.ExtensionContext, command: string): Promise<boolean> {
  // Destructive commands always ask, every time — checked first and
  // unconditionally, so no setting below (auto-approve patterns, Always
  // Allow) can ever skip this, on purpose.
  const reasons = destructiveReasons(command);
  if (reasons.length) {
    const choice = await vscode.window.showWarningMessage(
      `⚠️ This command is hard to reverse once run:\n\n${command}`,
      { modal: true, detail: `Why: ${reasons.join('; ')}.` },
      'Yes, run this destructive command',
    );
    return choice === 'Yes, run this destructive command';
  }

  if (isAutoApproved(command)) return true;
  // "Always Allow" covers single commands only: anything chained, piped,
  // substituted or redirected still asks, since one approved-looking
  // command could carry a second one along with it.
  const chained = hasShellControl(command);
  if (!chained && context.workspaceState.get(ALWAYS_ALLOW_COMMANDS_KEY)) return true;

  const choice = await vscode.window.showInformationMessage(
    chained
      ? `Run this command? It chains, pipes or redirects, so it always asks.\n\n${command}`
      : `Run this command?\n\n${command}`,
    { modal: true },
    'Approve',
    ...(chained ? [] : ['Always Allow (this project)']),
    'Reject',
  );
  if (choice === 'Always Allow (this project)') {
    await context.workspaceState.update(ALWAYS_ALLOW_COMMANDS_KEY, true);
    return true;
  }
  return choice === 'Approve';
}

const COMMAND_TIMEOUT_MS = 60_000;

// What a command produced, before redaction and capping.
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stopped?: boolean;
  spawnError?: string;
}

// Stop collecting beyond this (the rest is still drained so the process
// doesn't block); capOutput trims further before the model sees it.
const COMMAND_CAPTURE_MAX_CHARS = 2_000_000;

// Ends the command and everything it started. On macOS/Linux the shell is
// spawned as its own process group (detached), so a negative pid signals
// the whole group: a dev server or watcher it launched doesn't survive
// the timeout. Windows uses taskkill /T for the same.
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2000).unref();
}

function runShell(command: string, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<CommandResult, 'stdout' | 'stderr' | 'timedOut' | 'stopped'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, timedOut, stopped, ...r });
    };

    let child: ChildProcess;
    try {
      // stdin is closed: a command that waits for input fails right away
      // instead of hanging until the timeout.
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err: any) {
      resolve({ stdout: '', stderr: '', code: null, signal: null, timedOut: false, spawnError: err?.message ?? String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, COMMAND_TIMEOUT_MS);
    // Stop ends the command and everything it started.
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      killProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < COMMAND_CAPTURE_MAX_CHARS) stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < COMMAND_CAPTURE_MAX_CHARS) stderr += d;
    });
    child.on('error', (err) => finish({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

async function runCommand(context: vscode.ExtensionContext, command: string, signal?: AbortSignal): Promise<string> {
  if (typeof command !== 'string' || !command.trim()) return 'Error: run_command needs a non-empty "command" string.';
  const approved = await approveCommand(context, command);
  if (!approved) return 'User rejected running this command. Do not retry without asking why.';
  if (signal?.aborted) return 'Stopped: the user stopped this turn, so this command was not run.';

  // The editor's environment minus variables that usually hold
  // credentials (tokens, cloud keys), unless the user allowed them by name
  // in rizo.permissions.passEnvironmentVariables.
  const allow = vscode.workspace.getConfiguration('rizo').get<string[]>('permissions.passEnvironmentVariables', []);
  const { env, removed } = filterEnvironment(process.env, Array.isArray(allow) ? allow : []);

  const r = await runShell(command, getWorkspaceRoot(), env, signal);
  // A command's output is often an accidental exposure (`env`, `cat
  // .env`, `git log -p` on a repo with a committed secret). Redacted so it
  // never enters the model's context or thread history, then capped.
  const parts: string[] = [];
  if (r.stdout) parts.push(`stdout:\n${capOutput(redactSecrets(r.stdout))}`);
  if (r.stderr) parts.push(`stderr:\n${capOutput(redactSecrets(r.stderr))}`);
  if (r.spawnError) parts.push(`error: could not start the command: ${r.spawnError}`);
  if (r.stopped) parts.push('stopped: the user pressed Stop; the command and everything it started were ended');
  else if (r.timedOut) parts.push(`stopped after ${COMMAND_TIMEOUT_MS / 1000}s (timeout); the command and everything it started were ended`);
  else if (r.code !== 0 && r.code !== null) parts.push(`exit code: ${r.code}`);
  else if (r.signal) parts.push(`ended by signal ${r.signal}`);
  if (removed.length && r.code !== 0) {
    parts.push(
      `note: these environment variables were withheld because they usually hold credentials: ${removed.join(', ')}. If the command needs one, the user can allow it in the rizo.permissions.passEnvironmentVariables setting.`,
    );
  }
  return parts.join('\n\n') || '(command produced no output, exit code 0)';
}

// find_definition/find_references/call_hierarchy need a cursor position,
// not just a file — the model only has a symbol name and a file that
// mentions it. Resolves the first identifier-boundary occurrence in the
// file's current text and hands the language server that position. A
// symbol shadowed by an earlier same-named local can resolve to the
// wrong occurrence — an accepted tradeoff for not requiring the model to
// guess exact coordinates.
//
// Custom boundary lookaround instead of regex's own \b: \b is defined by
// \w ([A-Za-z0-9_]), which doesn't include $ — a real, valid identifier
// character in JS/TS (jQuery's convention). A plain \b-based search
// would silently never find a $-prefixed symbol. This treats $ as part
// of the identifier class the boundary check itself uses.
const IDENTIFIER_CHAR = 'A-Za-z0-9_$';
export function findSymbolPosition(text: string, symbol: string): vscode.Position | undefined {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![${IDENTIFIER_CHAR}])${escaped}(?![${IDENTIFIER_CHAR}])`);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (match) return new vscode.Position(i, match.index);
  }
  return undefined;
}

// vscode.executeDefinitionProvider can return either Location (uri/range)
// or LocationLink (targetUri/targetRange) depending on the language
// server. The other providers only return Location, but reusing one
// formatter for all of them means it needs to handle both.
function formatLocations(locations: (vscode.Location | vscode.LocationLink)[], root: string): string {
  return locations
    .map((loc) => {
      const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
      const range = 'targetRange' in loc ? loc.targetRange : loc.range;
      const rel = path.relative(root, uri.fsPath) || path.basename(uri.fsPath);
      return `${rel}:${range.start.line + 1}`;
    })
    .join('\n');
}

async function findDefinitionTool(filePath: string, symbol: string, extraRoots: string[]): Promise<string> {
  const resolved = resolveSafePath(filePath, extraRoots);
  if (!fs.existsSync(resolved)) return `Error: file not found: ${filePath}`;
  const pos = findSymbolPosition(currentContent(resolved), symbol);
  if (!pos) return `Error: "${symbol}" doesn't appear in ${filePath}. Check the spelling, or point at a file that actually mentions it.`;
  const results = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    vscode.Uri.file(resolved),
    pos,
  );
  if (!results || results.length === 0) {
    return `No definition found for "${symbol}" at that position. The language server may not be ready yet (just opened this project?), or this isn't a resolvable symbol here.`;
  }
  return `Definition of "${symbol}":\n${formatLocations(results, getWorkspaceRoot())}`;
}

async function findReferencesTool(filePath: string, symbol: string, extraRoots: string[]): Promise<string> {
  const resolved = resolveSafePath(filePath, extraRoots);
  if (!fs.existsSync(resolved)) return `Error: file not found: ${filePath}`;
  const pos = findSymbolPosition(currentContent(resolved), symbol);
  if (!pos) return `Error: "${symbol}" doesn't appear in ${filePath}. Check the spelling, or point at a file that actually mentions it.`;
  const results = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider',
    vscode.Uri.file(resolved),
    pos,
  );
  if (!results || results.length === 0) return `No references found for "${symbol}".`;
  return `${results.length} reference(s) to "${symbol}":\n${formatLocations(results, getWorkspaceRoot())}`;
}

async function callHierarchyTool(filePath: string, symbol: string, direction: string, extraRoots: string[]): Promise<string> {
  const resolved = resolveSafePath(filePath, extraRoots);
  if (!fs.existsSync(resolved)) return `Error: file not found: ${filePath}`;
  const pos = findSymbolPosition(currentContent(resolved), symbol);
  if (!pos) return `Error: "${symbol}" doesn't appear in ${filePath}. Check the spelling, or point at a file that actually mentions it.`;
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy',
    vscode.Uri.file(resolved),
    pos,
  );
  if (!items || items.length === 0) {
    return `Could not build a call hierarchy for "${symbol}" here: not every language/position supports it. Try find_references instead; it works for any resolvable symbol.`;
  }
  const root = getWorkspaceRoot();
  const lines: string[] = [];
  for (const item of items) {
    if (direction === 'incoming') {
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item);
      for (const c of calls || []) lines.push(`${c.from.name} (${path.relative(root, c.from.uri.fsPath)}:${c.from.range.start.line + 1})`);
    } else {
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item);
      for (const c of calls || []) lines.push(`${c.to.name} (${path.relative(root, c.to.uri.fsPath)}:${c.to.range.start.line + 1})`);
    }
  }
  if (lines.length === 0) return `No ${direction === 'incoming' ? 'callers' : 'calls'} found for "${symbol}".`;
  return `${direction === 'incoming' ? 'Callers of' : 'Calls made by'} "${symbol}":\n${lines.join('\n')}`;
}

// Two stored paths for the same file rarely match byte-for-byte across
// threads (different cwd, a leading "./", a dropped subdirectory) —
// exact match first, then falls back to path-suffix or same-basename, so
// a loose match still needs real overlap, not just a same-named file
// elsewhere.
function pathsLikelyMatch(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/').replace(/^\.\//, '');
  const nb = b.replace(/\\/g, '/').replace(/^\.\//, '');
  if (na === nb) return true;
  if (na.endsWith('/' + nb) || nb.endsWith('/' + na)) return true;
  return path.basename(na) === path.basename(nb) && path.basename(na) !== '';
}

// search_past_work's implementation — deterministic, no LLM call, built
// from StoredMessage.touchedFiles. currentThreadId is excluded: that
// thread's own history is already in the model's context.
function searchPastWork(context: vscode.ExtensionContext, targetPath: string, currentThreadId?: string): string {
  const hits: { threadName: string; when: string; snippet: string }[] = [];
  for (const meta of listThreads(context)) {
    if (meta.id === currentThreadId) continue;
    const thread = loadThread(context, meta.id);
    if (!thread) continue;
    for (let i = 0; i < thread.messages.length; i++) {
      const msg = thread.messages[i];
      if (msg.role !== 'assistant' || !msg.touchedFiles?.some((f) => pathsLikelyMatch(f, targetPath))) continue;
      const userMsg = thread.messages[i - 1];
      const snippet = userMsg && typeof userMsg.content === 'string' ? userMsg.content.trim().slice(0, 100) : '(no text prompt)';
      hits.push({ threadName: thread.name, when: thread.updatedAt, snippet });
    }
  }
  if (hits.length === 0) return `No record of "${targetPath}" being touched in any other thread.`;
  hits.sort((a, b) => b.when.localeCompare(a.when));
  const shown = hits.slice(0, 10);
  const lines = shown.map((h) => `- [${h.when}] "${h.threadName}": ${h.snippet}`);
  const omitted = hits.length - shown.length;
  if (omitted > 0) lines.push(`… and ${omitted} more, not shown.`);
  return `${hits.length} prior touch(es) of "${targetPath}" found:\n${lines.join('\n')}`;
}

export async function executeTool(
  context: vscode.ExtensionContext,
  name: string,
  argsJson: string,
  extraRoots: string[] = [],
  currentThreadId?: string,
  // The turn's Stop/close signal. Checked after every approval dialog:
  // a change approved after the user pressed Stop (or closed the panel)
  // is not applied, and a running command is ended.
  signal?: AbortSignal,
): Promise<string> {
  // Backstop for rizo.permissions.disabledTools — chatPanel.ts already
  // filters TOOLS before offering them to the model, so this only matters
  // if a call somehow still arrives here anyway (stale history, a model
  // ignoring its tool list).
  const disabledTools = vscode.workspace.getConfiguration('rizo').get<string[]>('permissions.disabledTools', []);
  if (disabledTools.includes(name)) {
    return `Error: the "${name}" tool is disabled for this workspace (rizo.permissions.disabledTools).`;
  }

  let args: any;
  try {
    args = JSON.parse(argsJson);
  } catch (err: any) {
    // Dumping the entire raw argsJson back here would waste tokens on a
    // large write_file/edit_file call — the next iteration pays to read
    // it again, and the model usually just regenerates the same giant
    // payload and hits the same error. JSON.parse's message already
    // names roughly where things broke; pairing it with a short excerpt
    // and a concrete suggestion (smaller calls) gives the model something
    // to act on.
    const excerpt = argsJson.length > 1500 ? `${argsJson.slice(0, 1500)}… (truncated, ${argsJson.length} chars total)` : argsJson;
    return `Error: could not parse tool arguments as JSON (${err.message}). If this was a large write_file/edit_file call, try breaking the content into a few smaller calls instead of one large one. Arguments received: ${excerpt}`;
  }

  try {
    switch (name) {
      case 'read_file': {
        const filePath = resolveSafePath(args.path, extraRoots);
        if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}`;
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return `Error: ${args.path} is a folder, not a file.`;
        if (stat.size > READ_MAX_FILE_BYTES) {
          return `Error: ${args.path} is ${Math.round(stat.size / 1024 / 1024)} MB, too large to read. Ask the user which part matters, or search it with a command.`;
        }
        // A binary file (PDF, image, archive) would otherwise be decoded
        // as UTF-8 and handed to the model as noise. Only the first 8 KB is
        // read for this check.
        if (looksBinary(readFileHead(filePath))) {
          return `Error: ${args.path} looks like a binary file, so it can't be read as text (no PDF/image/archive text extraction here). If you need its contents, ask the user to describe it or attach it as an image if it's a screenshot.`;
        }
        if (isSecretFile(filePath) && !(await approveSecretRead(args.path))) {
          return `The user did not allow reading ${args.path} (it usually holds secrets). Don't retry; ask the user for the specific value or setting you need instead.`;
        }
        return sliceForReading(currentContent(filePath), args.start_line, args.end_line);
      }

      case 'write_file': {
        if (typeof args.content !== 'string') return 'Error: write_file needs a "content" string.';
        const filePath = resolveSafePath(args.path, extraRoots);
        const isNew = !fs.existsSync(filePath);
        const oldContent = isNew ? '' : currentContent(filePath);
        const approved = await showApprovalDiff(context, args.path, oldContent, args.content, isNew, args.content);
        if (!approved) return 'User rejected this change. Do not retry the same edit without asking why.';
        if (changedSince(filePath, isNew ? undefined : oldContent)) {
          return `Error: ${args.path} changed while waiting for approval, so nothing was written. Read it again and redo the change.`;
        }
        if (signal?.aborted) return 'Stopped: the user stopped this turn, so this change was not applied.';
        await applyFileContent(filePath, args.content);
        return `Wrote ${args.path} (${isNew ? 'created' : 'overwritten'}).`;
      }

      case 'edit_file': {
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          return 'Error: edit_file needs "old_string" and "new_string" strings.';
        }
        const filePath = resolveSafePath(args.path, extraRoots);
        if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}. Use write_file to create a new file.`;
        const oldContent = currentContent(filePath);
        const result = replaceExactlyOnce(oldContent, args.old_string, args.new_string);
        if (!result.ok) {
          if (result.reason === 'empty') return 'Error: old_string is empty. Give the exact text to replace, or use write_file. No changes made.';
          if (result.reason === 'not-found') return `Error: old_string not found in ${args.path}. No changes made.`;
          return `Error: old_string appears ${result.count} times in ${args.path}. It must be unique. No changes made.`;
        }
        const approved = await showApprovalDiff(context, args.path, oldContent, result.content, false, args.new_string);
        if (!approved) return 'User rejected this change. Do not retry the same edit without asking why.';
        if (changedSince(filePath, oldContent)) {
          return `Error: ${args.path} changed while waiting for approval, so nothing was written. Read it again and redo the edit.`;
        }
        if (signal?.aborted) return 'Stopped: the user stopped this turn, so this change was not applied.';
        await applyFileContent(filePath, result.content);
        return `Edited ${args.path}.`;
      }

      case 'run_command':
        return await runCommand(context, args.command, signal);

      case 'search_past_work':
        return searchPastWork(context, args.path, currentThreadId);

      case 'find_definition':
        return await findDefinitionTool(args.path, args.symbol, extraRoots);

      case 'find_references':
        return await findReferencesTool(args.path, args.symbol, extraRoots);

      case 'call_hierarchy':
        return await callHierarchyTool(args.path, args.symbol, args.direction, extraRoots);

      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}
