import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { isDestructive } from './destructiveCommands';

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
// escapes the workspace root (path traversal, absolute paths elsewhere).
function resolveSafePath(relativePath: string): string {
  const root = getWorkspaceRoot();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${relativePath}" resolves outside the workspace root — refusing.`);
  }
  return resolved;
}

// Shows a native VS Code diff view of the proposed change, then a modal
// approve/reject prompt. Nothing is written to disk by this function —
// callers only proceed past it if the return value is true.
async function showApprovalDiff(relativePath: string, oldContent: string, newContent: string, isNew: boolean): Promise<boolean> {
  const tmpDir = os.tmpdir();
  const base = path.basename(relativePath);
  const stamp = Date.now();
  const oldTmp = path.join(tmpDir, `chai-agent-before-${stamp}-${base}`);
  const newTmp = path.join(tmpDir, `chai-agent-after-${stamp}-${base}`);
  fs.writeFileSync(oldTmp, oldContent);
  fs.writeFileSync(newTmp, newContent);

  const title = isNew ? `New file: ${relativePath}` : `Edit: ${relativePath}`;
  try {
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(oldTmp), vscode.Uri.file(newTmp), title);

    const choice = await vscode.window.showInformationMessage(
      `Apply this change to ${relativePath}?`,
      { modal: true },
      'Approve',
      'Reject',
    );
    return choice === 'Approve';
  } finally {
    try { fs.unlinkSync(oldTmp); } catch { /* best effort cleanup */ }
    try { fs.unlinkSync(newTmp); } catch { /* best effort cleanup */ }
  }
}

async function approveCommand(command: string): Promise<boolean> {
  if (isDestructive(command)) {
    const choice = await vscode.window.showWarningMessage(
      `⚠️ This command is hard to reverse once run:\n\n${command}`,
      { modal: true },
      'Yes, run this destructive command',
    );
    return choice === 'Yes, run this destructive command';
  }
  const choice = await vscode.window.showInformationMessage(
    `Run this command?\n\n${command}`,
    { modal: true },
    'Approve',
    'Reject',
  );
  return choice === 'Approve';
}

const COMMAND_TIMEOUT_MS = 60_000;

async function runCommand(command: string): Promise<string> {
  const approved = await approveCommand(command);
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

export async function executeTool(name: string, argsJson: string): Promise<string> {
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
        const approved = await showApprovalDiff(args.path, oldContent, args.content, isNew);
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
        const approved = await showApprovalDiff(args.path, oldContent, newContent, false);
        if (!approved) return 'User rejected this change. Do not retry the same edit without asking why.';
        fs.writeFileSync(filePath, newContent);
        return `Edited ${args.path}.`;
      }

      case 'run_command':
        return await runCommand(args.command);

      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}
