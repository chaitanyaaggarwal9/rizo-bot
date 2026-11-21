// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// The prompts that hand out trust: extra folders outside the workspace and
// repo-provided project notes. The rules themselves are pure functions in
// permissions.ts; this file only asks the user and remembers the answer.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkFolderGrant, contentFingerprint } from './permissions';
import { listThreads } from './threadStore';

// ---------- extra folders ----------

// workspaceState, not the thread file: threads are shared by every
// workspace, but a folder the user opened up while working in one project
// must not follow the chat into another one.
const FOLDER_GRANTS_KEY = 'rizo.folderGrants'; // Record<threadId, string[]>

type GrantMap = Record<string, string[]>;

function readGrants(context: vscode.ExtensionContext): GrantMap {
  const raw = context.workspaceState.get<GrantMap>(FOLDER_GRANTS_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Grants for this thread in this workspace that still exist on disk.
export function getFolderGrants(context: vscode.ExtensionContext, threadId: string): string[] {
  return (readGrants(context)[threadId] || []).filter((p) => typeof p === 'string' && fs.existsSync(p));
}

// candidates: real paths (fs.realpathSync) that the user's message names.
// Each one outside the workspace and not already granted gets an explicit
// modal question. Folders that are too broad or hold credentials are
// refused with an explanation instead of being offered at all.
// Returns every folder this thread may use after the user has answered.
export async function requestFolderGrants(
  context: vscode.ExtensionContext,
  threadId: string,
  candidates: string[],
  workspaceRoots: string[],
): Promise<string[]> {
  const granted = getFolderGrants(context, threadId);
  const added: string[] = [];

  for (const candidate of candidates) {
    const covered = [...workspaceRoots, ...granted, ...added].some((root) => isSameOrInside(candidate, root));
    if (covered) continue;

    const verdict = checkFolderGrant(candidate, os.homedir());
    if (!verdict.ok) {
      void vscode.window.showWarningMessage(
        `Rizo won't open up ${candidate} (${verdict.reason}). If you need a file from there, copy it into this workspace or attach it to the chat.`,
      );
      continue;
    }

    const choice = await vscode.window.showWarningMessage(
      `Your message mentions a path outside this workspace:\n\n${candidate}\n\nLet Rizo read files there for this chat?`,
      {
        modal: true,
        detail:
          'Rizo can then read anything under this path without asking each time, and what it reads is sent to the AI provider. Changes still need your approval. Revoke it any time with "Rizo: Manage Folder Access".',
      },
      'Allow for this chat',
    );
    if (choice === 'Allow for this chat') added.push(candidate);
  }

  if (added.length) {
    const all = readGrants(context);
    all[threadId] = [...new Set([...(all[threadId] || []), ...added])];
    await context.workspaceState.update(FOLDER_GRANTS_KEY, all);
  }
  return [...granted, ...added];
}

// "Rizo: Manage Folder Access": lists every folder granted in this
// workspace and revokes the ones the user picks.
export async function manageFolderAccess(context: vscode.ExtensionContext): Promise<void> {
  const all = readGrants(context);
  const names = new Map(listThreads(context).map((t) => [t.id, t.name]));
  const items = Object.entries(all).flatMap(([threadId, folders]) =>
    (folders || []).map((folder) => ({
      label: folder,
      description: names.get(threadId) ? `chat: ${names.get(threadId)}` : 'deleted chat',
      threadId,
    })),
  );
  if (!items.length) {
    void vscode.window.showInformationMessage('Rizo has no access to folders outside this workspace.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Rizo: folders outside this workspace',
    placeHolder: 'Select the folders to revoke, then press Enter',
  });
  if (!picked?.length) return;
  for (const item of picked) {
    all[item.threadId] = (all[item.threadId] || []).filter((f) => f !== item.label);
    if (!all[item.threadId].length) delete all[item.threadId];
  }
  await context.workspaceState.update(FOLDER_GRANTS_KEY, all);
  void vscode.window.showInformationMessage(`Revoked Rizo's access to ${picked.length} folder${picked.length === 1 ? '' : 's'}.`);
}

// ---------- project notes (.rizo/instructions.md) ----------

const PROJECT_NOTES_KEY = 'rizo.projectNotesDecision';

interface NotesDecision {
  fingerprint: string;
  use: boolean;
}

// Returns the notes if the user has agreed to use this exact version of
// the file in this workspace, asking once if they haven't decided yet.
// Any edit to the file (including one pulled from git) asks again.
export async function approvedProjectNotes(
  context: vscode.ExtensionContext,
  content: string,
  filePath: string | undefined,
): Promise<string> {
  if (!content) return '';
  const fingerprint = contentFingerprint(content);
  const saved = context.workspaceState.get<NotesDecision>(PROJECT_NOTES_KEY);
  if (saved && saved.fingerprint === fingerprint) return saved.use ? content : '';

  const choice = await vscode.window.showInformationMessage(
    saved
      ? 'The project notes for Rizo (.rizo/instructions.md) have changed. Use the new version?'
      : 'This workspace has project notes for Rizo (.rizo/instructions.md). Use them?',
    {
      modal: true,
      detail:
        'They were written by whoever controls this repository and are added to every request as context. Rizo treats them as notes, not commands, but only use them if you trust this repository.',
    },
    'Use them',
    "Don't use them",
    'Open the file',
  );

  if (choice === 'Open the file') {
    if (filePath) await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: true });
    return ''; // not used this turn; asked again next time
  }
  if (choice === 'Use them' || choice === "Don't use them") {
    await context.workspaceState.update(PROJECT_NOTES_KEY, { fingerprint, use: choice === 'Use them' });
    return choice === 'Use them' ? content : '';
  }
  return ''; // dismissed: not used, asked again next time
}
