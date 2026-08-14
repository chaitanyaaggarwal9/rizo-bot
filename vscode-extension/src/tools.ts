// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { isDestructive } from './destructiveCommands';
import { scanDangerousPatterns } from './dangerousPatterns';

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
      description: 'Read the contents of a file in the current workspace. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file, or fully overwrite an existing one, with the given content. Requires user approval — a diff is shown before anything is written to disk. Prefer edit_file for changes to existing files.',
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
        'Make a surgical edit to an existing file by replacing one exact occurrence of old_string with new_string. Prefer this over write_file for existing files — touch only what changed. Requires user approval before anything is written.',
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
        'Run a shell command in the workspace root — git, npm, tests, build scripts, etc. Requires user approval before running. Commands that look destructive (force-push, hard reset, branch deletion, rm -rf) get an extra emphasized warning, per Git Hygiene\'s rule that hard-to-reverse operations need the same confirm-first habit as any other risky action.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run' } },
        required: ['command'],
      },
    },
  },
];

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open — open a folder to let the agent read/edit files.');
  }
  return folders[0].uri.fsPath;
}

// Resolves a model-supplied relative path and refuses anything that
// escapes the workspace root — path traversal, absolute paths elsewhere,
// AND a symlink that lives inside the workspace but points outside it.
// The string check alone (path.resolve + startsWith) catches "../.." but
// not a symlink: fs.readFileSync/writeFileSync follow symlinks at the OS
// level, so a file that looks like it's inside the workspace can silently
// read or write somewhere else entirely. realpathSync resolves the actual
// target; walk up to the nearest existing ancestor first since a new file
// (write_file creating something that doesn't exist yet) has no realpath
// of its own to resolve.
function resolveSafePath(relativePath: string): string {
  const root = fs.realpathSync(getWorkspaceRoot());
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${relativePath}" resolves outside the workspace root — refusing.`);
  }

  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break; // hit the filesystem root — safety net, shouldn't happen
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  if (realAncestor !== root && !realAncestor.startsWith(root + path.sep)) {
    throw new Error(`Path "${relativePath}" escapes the workspace root via a symlink — refusing.`);
  }

  return resolved;
}

// Per-workspace "don't ask me again" flags. Deliberately NOT offered for
// destructive commands (see approveCommand) — that warning only means
// something if it can't be permanently silenced.
const ALWAYS_ALLOW_EDITS_KEY = 'rizo.alwaysAllowFileEdits';
const ALWAYS_ALLOW_COMMANDS_KEY = 'rizo.alwaysAllowCommands';

// Shows a native VS Code diff view of the proposed change, then a modal
// approve/reject prompt. Nothing is written to disk by this function —
// callers only proceed past it if the return value is true.
//
// scanTarget is deliberately separate from oldContent/newContent: it's just
// the part the model actually wrote (args.content for a new file, or
// args.new_string for edit_file's surgical replacement), not a full diff —
// so the security scan below doesn't re-flag pre-existing code elsewhere in
// a file that's simply being overwritten.
async function showApprovalDiff(
  context: vscode.ExtensionContext,
  relativePath: string,
  oldContent: string,
  newContent: string,
  isNew: boolean,
  scanTarget: string,
): Promise<boolean> {
  const matches = scanDangerousPatterns(scanTarget);

  if (context.workspaceState.get(ALWAYS_ALLOW_EDITS_KEY)) {
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

  const tmpDir = os.tmpdir();
  const base = path.basename(relativePath);
  const stamp = Date.now();
  const oldTmp = path.join(tmpDir, `rizo-before-${stamp}-${base}`);
  const newTmp = path.join(tmpDir, `rizo-after-${stamp}-${base}`);
  fs.writeFileSync(oldTmp, oldContent);
  fs.writeFileSync(newTmp, newContent);

  const title = isNew ? `New file: ${relativePath}` : `Edit: ${relativePath}`;
  try {
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(oldTmp), vscode.Uri.file(newTmp), title);

    const warningPrefix = matches.length
      ? `⚠️ Patterns worth a second look:\n${matches.map((m) => `• ${m.description}`).join('\n')}\n\n`
      : '';
    const showDialog = matches.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const choice = await showDialog(
      `${warningPrefix}Apply this change to ${relativePath}?`,
      { modal: true },
      'Approve',
      'Always Allow (this project)',
      'Reject',
    );
    if (choice === 'Always Allow (this project)') {
      await context.workspaceState.update(ALWAYS_ALLOW_EDITS_KEY, true);
      return true;
    }
    return choice === 'Approve';
  } finally {
    try { fs.unlinkSync(oldTmp); } catch { /* best effort cleanup */ }
    try { fs.unlinkSync(newTmp); } catch { /* best effort cleanup */ }
  }
}

// rizo.permissions.autoApproveCommandPatterns — regex strings tested against
// the full command. A bad/invalid regex from the user is skipped rather
// than crashing the extension over a settings typo.
function isAutoApproved(command: string): boolean {
  const patterns = vscode.workspace
    .getConfiguration('rizo')
    .get<string[]>('permissions.autoApproveCommandPatterns', []);
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(command);
    } catch {
      return false;
    }
  });
}

async function approveCommand(context: vscode.ExtensionContext, command: string): Promise<boolean> {
  // Destructive commands always ask, every time — checked first and
  // unconditionally, so no setting below (auto-approve patterns, Always
  // Allow) can ever skip this, on purpose.
  if (isDestructive(command)) {
    const choice = await vscode.window.showWarningMessage(
      `⚠️ This command is hard to reverse once run:\n\n${command}`,
      { modal: true },
      'Yes, run this destructive command',
    );
    return choice === 'Yes, run this destructive command';
  }

  if (isAutoApproved(command)) return true;
  if (context.workspaceState.get(ALWAYS_ALLOW_COMMANDS_KEY)) return true;

  const choice = await vscode.window.showInformationMessage(
    `Run this command?\n\n${command}`,
    { modal: true },
    'Approve',
    'Always Allow (this project)',
    'Reject',
  );
  if (choice === 'Always Allow (this project)') {
    await context.workspaceState.update(ALWAYS_ALLOW_COMMANDS_KEY, true);
    return true;
  }
  return choice === 'Approve';
}

const COMMAND_TIMEOUT_MS = 60_000;

async function runCommand(context: vscode.ExtensionContext, command: string): Promise<string> {
  const approved = await approveCommand(context, command);
  if (!approved) return 'User rejected running this command. Do not retry without asking why.';

  const root = getWorkspaceRoot();
  return new Promise((resolve) => {
    exec(command, { cwd: root, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      const parts: string[] = [];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      if (error) {
        const killed = (error as any).killed ? ' (killed — likely hit the 60s timeout)' : '';
        parts.push(`exit code: ${(error as any).code ?? 'unknown'}${killed}`);
      }
      resolve(parts.join('\n\n') || '(command produced no output, exit code 0)');
    });
  });
}

export async function executeTool(context: vscode.ExtensionContext, name: string, argsJson: string): Promise<string> {
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
  } catch {
    return `Error: could not parse tool arguments as JSON: ${argsJson}`;
  }

  try {
    switch (name) {
      case 'read_file': {
        const filePath = resolveSafePath(args.path);
        if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}`;
        return fs.readFileSync(filePath, 'utf-8');
      }

      case 'write_file': {
        const filePath = resolveSafePath(args.path);
        const isNew = !fs.existsSync(filePath);
        const oldContent = isNew ? '' : fs.readFileSync(filePath, 'utf-8');
        const approved = await showApprovalDiff(context, args.path, oldContent, args.content, isNew, args.content);
        if (!approved) return 'User rejected this change. Do not retry the same edit without asking why.';
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content);
        return `Wrote ${args.path} (${isNew ? 'created' : 'overwritten'}).`;
      }

      case 'edit_file': {
        const filePath = resolveSafePath(args.path);
        if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}. Use write_file to create a new file.`;
        const oldContent = fs.readFileSync(filePath, 'utf-8');
        const occurrences = oldContent.split(args.old_string).length - 1;
        if (occurrences === 0) return `Error: old_string not found in ${args.path}. No changes made.`;
        if (occurrences > 1) return `Error: old_string appears ${occurrences} times in ${args.path} — must be unique. No changes made.`;
        const newContent = oldContent.replace(args.old_string, args.new_string);
        const approved = await showApprovalDiff(context, args.path, oldContent, newContent, false, args.new_string);
        if (!approved) return 'User rejected this change. Do not retry the same edit without asking why.';
        fs.writeFileSync(filePath, newContent);
        return `Edited ${args.path}.`;
      }

      case 'run_command':
        return await runCommand(context, args.command);

      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}
