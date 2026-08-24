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
import { listThreads, loadThread } from './threadStore';

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
  {
    type: 'function',
    function: {
      name: 'search_past_work',
      description:
        "Search every OTHER chat thread in this workspace (not this one — that's already in your context) for prior work touching a specific file: which threads touched it, when, and what was being asked at the time. Useful before a risky change, or when the user asks something like \"didn't we already fix this?\" Deterministic — built from what read_file/write_file/edit_file actually touched in each past turn, not an AI guess at relevance.",
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
        "Jump to where a symbol (function, class, variable, type) is actually defined — uses the workspace's own language server (same engine as VS Code's \"Go to Definition\"), not a text search, so it resolves through imports and re-exports correctly. Faster and more accurate than grepping for the declaration by hand.",
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
        "Find every place a symbol is used across the whole workspace — same engine as VS Code's \"Find All References\", not a text search, so it won't miss a usage or match an unrelated same-named symbol elsewhere. Use before renaming or changing a function's signature to see everything that would break.",
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
        "For a function specifically: who calls it, or what it calls — one level, not a text search. \"incoming\" answers \"what breaks if I change this function's behavior\"; \"outgoing\" answers \"what does this function actually depend on\". Falls back to find_references-like behavior if the language server can't build a call hierarchy for this symbol (some languages/positions don't support it).",
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
        if (fs.existsSync(resolved)) existing = currentContent(resolved);
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
    throw new Error('No workspace folder is open — open a folder to let the agent read/edit files.');
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
    throw new Error('No workspace folder is open — open a folder to let the agent read/edit files.');
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
// extraRoots (default none): paths chatPanel.ts's handleSend found in
// the human's own message text and verified exist — see threadStore.ts's
// Thread.extraRoots for why only that source is trusted.
function resolveSafePath(relativePath: string, extraRoots: string[] = []): string {
  const roots = [...getWorkspaceRoots(), ...extraRoots.map((r) => fs.realpathSync(r))];
  // path.resolve treats an already-absolute second argument as an
  // override of the first — a relative path resolves against the primary
  // folder, while an absolute path pointing at another open folder
  // resolves to itself and gets checked against every root below.
  const resolved = path.resolve(roots[0], relativePath);
  const matchedRoot = roots.find((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!matchedRoot) {
    // Names the actual fix, not just the refusal — the model relays this to the user.
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
      // Unlike read_file (which deliberately reads whatever file the
      // model asked for), a command's output is often an accidental
      // exposure: `env`, `cat .env`, `git log -p` on a repo with a
      // committed secret. Redacted here so it never enters the model's
      // context or thread history — the command's own text is what gets
      // approved, not its output, so there's no review step for the
      // output itself.
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
  if (!pos) return `Error: "${symbol}" doesn't appear in ${filePath} — check the spelling, or point at a file that actually mentions it.`;
  const results = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    vscode.Uri.file(resolved),
    pos,
  );
  if (!results || results.length === 0) {
    return `No definition found for "${symbol}" at that position — the language server may not be ready yet (just opened this project?), or this isn't a resolvable symbol here.`;
  }
  return `Definition of "${symbol}":\n${formatLocations(results, getWorkspaceRoot())}`;
}

async function findReferencesTool(filePath: string, symbol: string, extraRoots: string[]): Promise<string> {
  const resolved = resolveSafePath(filePath, extraRoots);
  if (!fs.existsSync(resolved)) return `Error: file not found: ${filePath}`;
  const pos = findSymbolPosition(currentContent(resolved), symbol);
  if (!pos) return `Error: "${symbol}" doesn't appear in ${filePath} — check the spelling, or point at a file that actually mentions it.`;
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
  if (!pos) return `Error: "${symbol}" doesn't appear in ${filePath} — check the spelling, or point at a file that actually mentions it.`;
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy',
    vscode.Uri.file(resolved),
    pos,
  );
  if (!items || items.length === 0) {
    return `Could not build a call hierarchy for "${symbol}" here — not every language/position supports it. Try find_references instead; it works for any resolvable symbol.`;
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
        // Without this, a binary file (PDF, image, archive) got
        // force-decoded as UTF-8 and handed to the model as garbled noise
        // with no error, wasting tokens on nothing useful. Same
        // null-byte-in-first-8KB heuristic as the attachment flow — the
        // standard cheap tell git itself uses.
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
