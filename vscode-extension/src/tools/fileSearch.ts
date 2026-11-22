// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// The core of the search_files tool: searching a list of workspace files
// for a literal string or regex, with limits so a broad search can't
// flood the conversation or hang the editor. Which files to search is
// decided by tools.ts (workspace folders, .gitignore, excludes). No
// 'vscode' import: tested in fileSearch.test.ts.

import { looksBinary } from '../safety/pathPolicy';
import { isSecretFile } from '../safety/permissions';
import { redactSecrets } from '../safety/outputRedaction';

export const DEFAULT_MAX_RESULTS = 100;
export const MAX_RESULTS_CAP = 500;
export const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 300;
// Lines longer than this (minified bundles, data blobs) are skipped: they
// aren't useful results and are where slow regexes hurt most.
const MAX_SEARCHABLE_LINE = 5_000;
const TIME_BUDGET_MS = 8_000;

export interface SearchRequest {
  pattern: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface SearchMatch {
  path: string; // workspace-relative
  line: number; // 1-based
  text: string;
}

export interface SearchOutcome {
  matches: SearchMatch[];
  filesSearched: number;
  truncated: boolean;
  timedOut: boolean;
  skippedSecretFiles: number;
}

// A safe RegExp for the request, or an error message for the model.
export function compileSearch(req: SearchRequest): RegExp | { error: string } {
  if (typeof req.pattern !== 'string' || !req.pattern) return { error: 'search_files needs a non-empty "pattern".' };
  if (req.pattern.length > 500) return { error: 'The pattern is too long (max 500 characters).' };
  const source = req.isRegex ? req.pattern : req.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, req.caseSensitive ? '' : 'i');
  } catch (err: any) {
    return { error: `Invalid regular expression: ${err?.message ?? String(err)}` };
  }
}

function clampResults(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_RESULTS_CAP) : DEFAULT_MAX_RESULTS;
}

// Searches files in order until maxResults matches or the time budget runs
// out. readFile returns the file's bytes, or undefined if unreadable.
export function searchFiles(
  files: { path: string; absPath: string }[],
  readFile: (absPath: string) => Buffer | undefined,
  regex: RegExp,
  maxResults?: number,
  now: () => number = Date.now,
): SearchOutcome {
  const limit = clampResults(maxResults);
  const started = now();
  const out: SearchOutcome = { matches: [], filesSearched: 0, truncated: false, timedOut: false, skippedSecretFiles: 0 };
  for (const f of files) {
    if (now() - started > TIME_BUDGET_MS) {
      out.timedOut = true;
      break;
    }
    // Files that usually hold secrets are never searched: their content
    // would go to the AI provider without the per-read approval read_file asks for.
    if (isSecretFile(f.path)) {
      out.skippedSecretFiles++;
      continue;
    }
    const buf = readFile(f.absPath);
    if (!buf || buf.length > MAX_FILE_BYTES || looksBinary(buf.subarray(0, 8000))) continue;
    out.filesSearched++;
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > MAX_SEARCHABLE_LINE || !regex.test(line)) continue;
      if (out.matches.length >= limit) {
        out.truncated = true;
        return out;
      }
      const trimmed = line.trim();
      out.matches.push({
        path: f.path,
        line: i + 1,
        text: redactSecrets(trimmed.length > MAX_LINE_CHARS ? trimmed.slice(0, MAX_LINE_CHARS) + '…' : trimmed),
      });
    }
  }
  return out;
}

export function formatSearchOutcome(o: SearchOutcome, pattern: string): string {
  if (!o.matches.length) {
    const why = o.timedOut ? ' (the search stopped early: narrow it with "include")' : '';
    return `No matches for ${JSON.stringify(pattern)} in ${o.filesSearched} files${why}.`;
  }
  const lines = o.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
  const notes: string[] = [];
  if (o.truncated) notes.push(`showing the first ${o.matches.length} matches; narrow the search (pattern or "include") to see others`);
  if (o.timedOut) notes.push('the search stopped early because it took too long; narrow it with "include"');
  if (o.skippedSecretFiles) notes.push(`${o.skippedSecretFiles} file(s) that usually hold secrets (.env, keys) were not searched`);
  return `${o.matches.length} match${o.matches.length === 1 ? '' : 'es'} in ${o.filesSearched} files searched:\n${lines.join('\n')}${notes.length ? `\n\n(${notes.join('; ')})` : ''}`;
}

// ---------- update_plan ----------

export type PlanStatus = 'pending' | 'in_progress' | 'done';
export interface PlanStep {
  step: string;
  status: PlanStatus;
}

export function parsePlan(raw: unknown): PlanStep[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'update_plan needs a non-empty "steps" array.' };
  if (raw.length > 30) return { error: 'Keep the plan to 30 steps or fewer.' };
  const steps: PlanStep[] = [];
  for (const s of raw) {
    const text = typeof s?.step === 'string' ? s.step.trim().slice(0, 200) : '';
    const status: PlanStatus = s?.status === 'done' || s?.status === 'in_progress' ? s.status : 'pending';
    if (!text) return { error: 'Every plan step needs a "step" description.' };
    steps.push({ step: text, status });
  }
  return steps;
}

export function formatPlan(steps: PlanStep[]): string {
  const mark = { done: '[x]', in_progress: '[>]', pending: '[ ]' } as const;
  return steps.map((s) => `${mark[s.status]} ${s.step}`).join('\n');
}

export function planProgress(steps: PlanStep[]): string {
  return `${steps.filter((s) => s.status === 'done').length}/${steps.length} done`;
}
