// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Reads what `rizolang audit <file.rz> --json` prints: either compile
// errors ({ ok: false, errors }) or audit findings ({ ok, findings,
// summary }), each with a code, message, fix and 1-based location. No
// 'vscode' import: tested in auditOutput.test.ts.

export type Severity = 'error' | 'warning' | 'note';

export interface Problem {
  severity: Severity;
  code: string;
  message: string;
  fix: string;
  line: number | null; // 1-based; null when not about a line
  column: number | null; // 1-based
  length: number | null;
}

export interface AuditResult {
  version: string | null;
  problems: Problem[];
  // From the audit summary, when the file compiled.
  endpoints?: number;
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < 10_000_000 ? v : null);

function toProblem(raw: any, severity: Severity): Problem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const code = str(raw.code, 20);
  if (!/^R[A-Z]\d{2,5}$/.test(code)) return undefined;
  return {
    severity,
    code,
    message: str(raw.message) || code,
    fix: str(raw.fix),
    line: pos(raw.line),
    column: pos(raw.column),
    length: pos(raw.length),
  };
}

// The last line of stdout that is a JSON object (the compiler prints one).
export function parseAuditOutput(stdout: string): AuditResult | { error: string } {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'));
  if (!line) return { error: 'The compiler printed no JSON result.' };
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return { error: 'The compiler printed a result that is not valid JSON.' };
  }
  if (!data || typeof data !== 'object') return { error: 'Unexpected compiler output.' };
  const version = typeof data.rizolang === 'string' ? data.rizolang.slice(0, 40) : null;
  const problems: Problem[] = [];
  if (Array.isArray(data.errors)) {
    for (const e of data.errors.slice(0, 500)) {
      const p = toProblem(e, 'error');
      if (p) problems.push(p);
    }
  }
  if (Array.isArray(data.findings)) {
    for (const f of data.findings.slice(0, 500)) {
      const p = toProblem(f, f?.level === 'note' ? 'note' : 'warning');
      if (p) problems.push(p);
    }
  }
  if (!Array.isArray(data.errors) && !Array.isArray(data.findings)) return { error: 'Unexpected compiler output.' };
  const endpoints = typeof data.summary?.endpoints === 'number' ? data.summary.endpoints : undefined;
  return { version, problems, endpoints };
}

// The result as text for the model (rizolang_check tool).
export function formatForModel(file: string, result: AuditResult): string {
  const where = (p: Problem) => (p.line ? `${file}:${p.line}:${p.column ?? 1}` : file);
  const by = result.version ? ` (rizolang ${result.version})` : '';
  if (!result.problems.length) {
    return `${file} builds and the audit found nothing${by}.${result.endpoints !== undefined ? ` ${result.endpoints} endpoint(s).` : ''}`;
  }
  const errors = result.problems.filter((p) => p.severity === 'error').length;
  const head = errors
    ? `${file} does not build: ${errors} error(s)${by}. Fix them, then check again.`
    : `${file} builds. The audit found ${result.problems.length} item(s)${by}. Fix every warning; notes are suggestions.`;
  const lines = result.problems.map((p) => `${where(p)} ${p.severity} ${p.code}: ${p.message}${p.fix ? `\n  fix: ${p.fix}` : ''}`);
  return `${head}\n\n${lines.join('\n')}`;
}
