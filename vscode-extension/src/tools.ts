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
import { redactSecrets } from './outputRedaction';

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
        'Run a shell command in the workspace root — git, npm, tests, build scripts, etc. Requires user approval before running. Commands that look destructive (force-push, hard reset, branch deletion, rm -rf) or that hide what they actually run (piping a remote download into a shell, `bash -c "..."`, `eval`) get an extra emphasized warning, per Git Hygiene\'s rule that hard-to-reverse or opaque operations need the same confirm-first habit as any other risky action.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          description: {
            type: 'string',
            description:
              'A short (5-10 word), imperative-mood, present-tense summary of what this command does and why, e.g. "Check whether the release tag matches package.json" — NOT a restatement of the command text itself. Shown as the line in the live transcript; the exact command is available on expand.',
          },
        },
        required: ['command', 'description'],
      },
    },
  },
];

// For the live tool-call transcript in chatPanel.ts's two-tier card: label
// is the short tool-type tag ("Bash", "Read", ...), title is the one-line
// human-readable summary always visible, detail is the exact
// command/args shown only when the card is expanded — same split as
// Claude Code's own Bash tool (a required "description" parameter
// separate from "command", specifically so the visible line is intent,
// not syntax). Best-effort: a malformed args string (still being
// streamed, or just malformed) falls back to the bare tool name rather
// than throwing.
export interface ToolCallSummary {
  label: string;
  title: string;
  detail?: string;
}

// A truncated write_file/edit_file call (hit the model's token ceiling
// mid-content — see openrouter.ts's MAX_TOKENS comment) fails JSON.parse
// entirely, but "path" is a short field every tool schema declares
// before the often-huge content field, so it's usually still intact in
// the raw string even when the rest of the JSON isn't. Regex-recovers
// just that field rather than showing "(unknown path)" for a call whose
// target file is actually known.
function extractPathFallback(argsJson: string): string | undefined {
  const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argsJson);
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
}

export function summarizeToolCall(name: string, argsJson: string): ToolCallSummary {
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
    case 'write_file':
      return { label: 'Write', title: path ?? '(unknown path)' };
    case 'edit_file':
      return { label: 'Edit', title: path ?? '(unknown path)' };
    case 'run_command':
      // description is a required parameter now, but history replayed
      // from before this shipped (or a model that just doesn't comply)
      // won't have one — falls back to showing the command itself as
      // the title in that case, same as the old single-line behavior.
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
    throw new Error('No workspace folder is open — open a folder to let the agent read/edit files.');
  }
  return folders[0].uri.fsPath;
}

// Every open workspace folder's real path, not just the first — a
// multi-root workspace (File > Add Folder to Workspace...) is the same
// explicit, deliberate trust decision opening a single folder always
// was, so every folder in it should actually be usable by read_file/
// write_file/edit_file, not silently limited to whichever one VS Code
// happened to list first. Only resolveSafePath needs this — run_command's
// cwd (getWorkspaceRoot, above) still only ever means the primary
// folder, since a shell command can only run in one directory at a time.
function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open — open a folder to let the agent read/edit files.');
  }
  return folders.map((f) => fs.realpathSync(f.uri.fsPath));
}

// Resolves a model-supplied path and refuses anything that escapes every
// open workspace folder or explicitly-granted extra root — path
// traversal, an absolute path nowhere any of them, AND a symlink that
// lives inside one but points outside it. The string check alone
// (path.resolve + startsWith) catches "../.." but not a symlink:
// fs.readFileSync/writeFileSync follow symlinks at the OS level, so a
// file that looks like it's inside an allowed root can silently read or
// write somewhere else entirely. realpathSync resolves the actual
// target; walk up to the nearest existing ancestor first since a new
// file (write_file creating something that doesn't exist yet) has no
// realpath of its own to resolve.
//
// extraRoots (default none) come from chatPanel.ts's handleSend, one
// layer up — paths the *human's own message text* named and that
// actually exist on disk, threaded through executeTool for exactly this
// call. Same trust boundary as "Attach file...": a model reaching
// outside the workspace on its own is the risk this function exists to
// stop; a human naming a folder in their own message isn't that risk,
// so it gets treated the same as an already-open workspace folder for
// the rest of this call (and, since chatPanel.ts persists it, this
// thread).
function resolveSafePath(relativePath: string, extraRoots: string[] = []): string {
  const roots = [...getWorkspaceRoots(), ...extraRoots.map((r) => fs.realpathSync(r))];
  // path.resolve treats an already-absolute second argument as an
  // override of the first (the base only matters for a genuinely
  // relative path) — so a relative path resolves against the primary
  // folder as always, while an absolute path pointing at any OTHER open
  // folder in a multi-root workspace resolves to itself and gets
  // checked against every root below, not just the first.
  const resolved = path.resolve(roots[0], relativePath);
  const matchedRoot = roots.find((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!matchedRoot) {
    // Actionable, not just a refusal — the model relays this verbatim-ish
    // to the user, and "add the folder to your workspace" is a real,
    // one-click fix (File > Add Folder to Workspace..., or drag it into
    // the Explorer sidebar), not a dead end.
    throw new Error(
      `Path "${relativePath}" resolves outside every open workspace folder — refusing. To work with a different folder, add it to this VS Code workspace first (File > Add Folder to Workspace..., or drag it into the Explorer sidebar) — every folder in a multi-root workspace is usable, not just the first one.`,
    );
  }

  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break; // hit the filesystem root — safety net, shouldn't happen
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  if (realAncestor !== matchedRoot && !realAncestor.startsWith(matchedRoot + path.sep)) {
    throw new Error(`Path "${relativePath}" escapes the workspace root via a symlink — refusing.`);
  }

  return resolved;
}

// The file's true current content — the live editor buffer if one's
// open (even unsaved: that IS the real content, whether or not it's hit
// disk yet), otherwise whatever's on disk. Read-only: never writes
// anything. An earlier version force-saved a dirty editor before
// reading/writing it, on the reasoning that read_file returning stale
// disk content while the real content sat unsaved was worse. That part
// held up, but it had a real side effect nothing caught until a security
// pass: write_file/edit_file's approval-diff dialog was built *after*
// that forced save already ran, so clicking "Reject" on the proposed
// change didn't undo the unrelated autosave — whatever draft happened to
// be open got permanently written to disk regardless of the user's
// answer. Reading the live buffer instead of saving it sidesteps that
// entirely: nothing touches disk until there's an actual approved write,
// and read_file still sees the real content either way.
function currentContent(filePath: string): string {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
  return doc ? doc.getText() : fs.readFileSync(filePath, 'utf-8');
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
      // Unlike read_file (deliberately reads whatever file the model
      // asked for — reviewed and accepted as this app's designed
      // behavior, not a gap), a command's output is often an accidental
      // exposure: `env`, `cat .env`, `aws configure list`, `git log -p`
      // on a repo with a committed secret — the model's *intent* was
      // rarely "show me a credential," it just happened to be in the
      // output. Redacted here so it never enters the model's context
      // (and from there, thread history on disk, and back out to
      // OpenRouter) at all, rather than relying on a human to notice it
      // in the approval prompt — the command's own text is what gets
      // approved, not its output, so there's no review step for this.
      const stdoutSafe = stdout ? redactSecrets(stdout) : stdout;
      const stderrSafe = stderr ? redactSecrets(stderr) : stderr;
      const parts: string[] = [];
      if (stdoutSafe) parts.push(`stdout:\n${stdoutSafe}`);
      if (stderrSafe) parts.push(`stderr:\n${stderrSafe}`);
      if (error) {
        const killed = (error as any).killed ? ' (killed — likely hit the 60s timeout)' : '';
        parts.push(`exit code: ${(error as any).code ?? 'unknown'}${killed}`);
      }
      resolve(parts.join('\n\n') || '(command produced no output, exit code 0)');
    });
  });
}

export async function executeTool(context: vscode.ExtensionContext, name: string, argsJson: string, extraRoots: string[] = []): Promise<string> {
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
    // Used to dump the entire raw argsJson back into this message — for a
    // write_file/edit_file call on a real file that's easily several
    // thousand characters, and this string becomes the tool result the
    // *next* iteration pays to read again. Doubly wasteful on a genuine
    // parse failure, since the model then usually just regenerates the
    // same giant payload from scratch and hits the same error again
    // (openrouter.ts's stream reassembly now recovers the one most
    // common cause of this — a large string split across SSE frames —
    // but a model can still emit genuinely invalid JSON on its own).
    // JSON.parse's own message already names roughly where things broke;
    // pairing it with a short excerpt and a concrete suggestion (smaller
    // calls) gives the model something to actually act on instead of a
    // wall of text it can't use.
    const excerpt = argsJson.length > 1500 ? `${argsJson.slice(0, 1500)}… (truncated, ${argsJson.length} chars total)` : argsJson;
    return `Error: could not parse tool arguments as JSON (${err.message}). If this was a large write_file/edit_file call, try breaking the content into a few smaller calls instead of one large one. Arguments received: ${excerpt}`;
  }

  try {
    switch (name) {
      case 'read_file': {
        const filePath = resolveSafePath(args.path, extraRoots);
        if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}`;
        // Unlike the attachment flow (readAndSendAttachment in
        // chatPanel.ts), which already rejects binary files with a clear
        // warning before a human ever sees them, this had no such check
        // at all — a PDF, image, archive, or any other binary file was
        // force-decoded as UTF-8 via fs.readFileSync's 'utf-8' encoding
        // inside currentContent() and handed to the model as garbled
        // noise with no error, silently wasting tokens on nothing
        // useful. Same null-byte-in-first-8KB heuristic as the
        // attachment flow (the standard cheap tell — it's what git
        // itself uses to decide binary vs text).
        const head = fs.readFileSync(filePath).subarray(0, 8000);
        if (head.includes(0)) {
          return `Error: ${args.path} looks like a binary file — can't read it as text (no PDF/image/archive text extraction here). If you need its contents, ask the user to describe it or attach it as an image if it's a screenshot.`;
        }
        return currentContent(filePath);
      }

      case 'write_file': {
        const filePath = resolveSafePath(args.path, extraRoots);
        const isNew = !fs.existsSync(filePath);
        const oldContent = isNew ? '' : currentContent(filePath);
        const approved = await showApprovalDiff(context, args.path, oldContent, args.content, isNew, args.content);
        if (!approved) return 'User rejected this change. Do not retry the same edit without asking why.';
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content);
        return `Wrote ${args.path} (${isNew ? 'created' : 'overwritten'}).`;
      }

      case 'edit_file': {
        const filePath = resolveSafePath(args.path, extraRoots);
        if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}. Use write_file to create a new file.`;
        const oldContent = currentContent(filePath);
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
