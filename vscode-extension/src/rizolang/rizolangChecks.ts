// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Rizo Lang checks in the editor: errors and audit findings for .rz files
// as you type, a "Fix with Rizo" quick fix, and the check behind the
// rizolang_check tool.
//
// Security rules:
// - Only the project's own compiler (node_modules/rizolang) is used, and
//   only after the user allows it for this project. Allowing is per
//   compiler path and version, so an update asks again.
// - Only `rizolang audit --json` runs (it writes nothing), on a copy of
//   the file in a private temp folder, with credentials withheld from its
//   environment and a time limit.
// - Rizo never installs the compiler; it only suggests the command.

import * as path from 'path';
import * as vscode from 'vscode';
import { AuditResult, formatForModel, Problem } from './auditOutput';
import { Compiler, compilerKey, findCompiler, runAudit } from './compiler';

const ALLOWED_KEY = 'rizo.rizolang.allowedCompilers';
const DEBOUNCE_MS = 700;
const ERRORS_URL = 'https://github.com/chaitanyaaggarwal9/rizolang/blob/main/docs/SPEC.md#8-errors';
const INSTALL = 'npm install --save-dev rizolang';

function enabled(): boolean {
  return vscode.workspace.getConfiguration('rizo').get<boolean>('rizolang.checks', true);
}

export class RizoLangChecks implements vscode.Disposable, vscode.CodeActionProvider {
  private readonly collection = vscode.languages.createDiagnosticCollection('rizolang');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, AbortController>();
  // Asked this session and the user said "Not now" / already told about
  // a missing compiler: don't ask again until the editor restarts.
  private readonly declined = new Set<string>();
  private readonly toldMissing = new Set<string>();
  private readonly asking = new Map<string, Promise<boolean>>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, DEBOUNCE_MS)),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidCloseTextDocument((d) => this.clear(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('rizo.rizolang.checks') && !enabled()) this.collection.clear();
      }),
      vscode.languages.registerCodeActionsProvider({ language: 'rizolang' }, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.commands.registerCommand('rizo.rizolang.fixWithRizo', (uri: vscode.Uri, d: { code: string; message: string; fix: string; line: number; column: number; severity: string }) =>
        this.fixWithRizo(uri, d),
      ),
    );
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  // ---------- compiler and consent ----------

  private compilerFor(uri: vscode.Uri): Compiler | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || uri.scheme !== 'file') return undefined;
    return findCompiler(path.dirname(uri.fsPath), folder.uri.fsPath);
  }

  private isAllowed(c: Compiler): boolean {
    return this.context.workspaceState.get<string[]>(ALLOWED_KEY, []).includes(compilerKey(c));
  }

  // Asks once per compiler (path + version) per project. `modal` when a
  // tool call is waiting on the answer.
  private ask(c: Compiler, modal: boolean): Promise<boolean> {
    const key = compilerKey(c);
    if (this.isAllowed(c)) return Promise.resolve(true);
    if (!modal && this.declined.has(key)) return Promise.resolve(false);
    const pending = this.asking.get(key);
    if (pending) return pending;
    const p = (async () => {
      const allow = 'Allow for this project';
      const rel = vscode.workspace.asRelativePath(c.packageDir, false);
      const pick = await vscode.window.showInformationMessage(
        `Check Rizo Lang files with this project's compiler (rizolang ${c.version} in ${rel})?`,
        {
          modal,
          detail: modal
            ? 'Rizo runs "rizolang audit", which compiles and reviews a copy of the file and writes nothing to your project.'
            : undefined,
        },
        allow,
        ...(modal ? [] : ['Not now']),
      );
      if (pick === allow) {
        await this.context.workspaceState.update(ALLOWED_KEY, [...this.context.workspaceState.get<string[]>(ALLOWED_KEY, []), key]);
        return true;
      }
      this.declined.add(key);
      return false;
    })().finally(() => this.asking.delete(key));
    this.asking.set(key, p);
    return p;
  }

  private tellMissing(folder: string): void {
    if (this.toldMissing.has(folder)) return;
    this.toldMissing.add(folder);
    const copy = 'Copy command';
    void vscode.window
      .showInformationMessage(`To see errors in .rz files, install the Rizo Lang compiler in this project: ${INSTALL}`, copy)
      .then((pick) => {
        if (pick === copy) void vscode.env.clipboard.writeText(INSTALL);
      });
  }

  private audit(c: Compiler, source: string, uri: vscode.Uri, signal?: AbortSignal) {
    const envAllow = vscode.workspace.getConfiguration('rizo').get<string[]>('permissions.passEnvironmentVariables', []);
    return runAudit(c, source, path.basename(uri.fsPath), { envAllow, signal });
  }

  // ---------- diagnostics ----------

  private schedule(doc: vscode.TextDocument, delay: number): void {
    if (doc.languageId !== 'rizolang' || doc.uri.scheme !== 'file' || !enabled()) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(doc);
      }, delay),
    );
  }

  private async check(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder || doc.isClosed) return;
    const compiler = this.compilerFor(doc.uri);
    if (!compiler) {
      this.tellMissing(folder.uri.toString());
      return;
    }
    if (!(await this.ask(compiler, false))) return;
    this.running.get(key)?.abort();
    const ac = new AbortController();
    this.running.set(key, ac);
    const version = doc.version;
    const result = await this.audit(compiler, doc.getText(), doc.uri, ac.signal);
    if (this.running.get(key) === ac) this.running.delete(key);
    if (ac.signal.aborted || doc.isClosed || doc.version !== version) return;
    if ('error' in result) {
      this.collection.set(doc.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `Rizo Lang check failed: ${result.error}`, vscode.DiagnosticSeverity.Information)]);
      return;
    }
    this.collection.set(doc.uri, result.problems.map((p) => toDiagnostic(doc, p)));
  }

  private clear(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.running.get(key)?.abort();
    this.running.delete(key);
    this.collection.delete(uri);
  }

  // ---------- quick fix ----------

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    return ctx.diagnostics
      .filter((d) => d.source === 'rizolang' && d.code !== undefined)
      .map((d) => {
        const p = fromDiagnostic(d);
        const action = new vscode.CodeAction(`Fix with Rizo: ${p.code}`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        action.command = {
          command: 'rizo.rizolang.fixWithRizo',
          title: 'Fix with Rizo',
          arguments: [doc.uri, { code: p.code, message: p.message, fix: p.fix, line: p.line ?? 1, column: p.column ?? 1, severity: p.severity }],
        };
        return action;
      });
  }

  // Opens the chat with a ready-to-send request; the user presses Enter.
  private async fixWithRizo(uri: vscode.Uri, d: { code: string; message: string; fix: string; line: number; column: number; severity: string }): Promise<void> {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const text = `Fix this Rizo Lang ${d.severity} in ${rel}:${d.line}:${d.column}\n${d.code}: ${d.message}${d.fix ? `\nSuggested fix: ${d.fix}` : ''}\nThen check the file with rizolang_check.`;
    await vscode.commands.executeCommand('rizo.openChat');
    const { ChatPanel } = await import('../ui/chatPanel');
    await ChatPanel.currentPanel?.prefillComposer(text);
  }

  // ---------- the rizolang_check tool ----------

  // Checks a .rz file (the editor's text when it's open) and returns text
  // for the model. Starts with "Error:" when the check couldn't run.
  async checkForTool(absPath: string, signal?: AbortSignal): Promise<string> {
    const uri = vscode.Uri.file(absPath);
    const rel = vscode.workspace.asRelativePath(uri, false);
    const compiler = this.compilerFor(uri);
    if (!compiler) {
      return `Error: this project has no Rizo Lang compiler (node_modules/rizolang). Ask the user to run "${INSTALL}", or check the file against the spec by reading it carefully.`;
    }
    if (!(await this.ask(compiler, true))) return 'Error: the user did not allow running the Rizo Lang compiler in this project.';
    if (signal?.aborted) return 'Error: stopped by the user.';
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    let source: string;
    try {
      source = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return `Error: file not found: ${rel}`;
    }
    const result: AuditResult | { error: string } = await this.audit(compiler, source, uri, signal);
    if ('error' in result) return `Error: the Rizo Lang check failed: ${result.error}`;
    if (open) this.collection.set(open.uri, result.problems.map((p) => toDiagnostic(open, p)));
    return formatForModel(rel, result);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const a of this.running.values()) a.abort();
    for (const d of this.disposables) d.dispose();
  }
}

const SEVERITY: Record<Problem['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(doc: vscode.TextDocument, p: Problem): vscode.Diagnostic {
  const line = Math.min(Math.max((p.line ?? 1) - 1, 0), Math.max(doc.lineCount - 1, 0));
  const start = Math.max((p.column ?? 1) - 1, 0);
  const end = p.length ? start + p.length : doc.lineAt(line).range.end.character;
  const range = doc.validateRange(new vscode.Range(line, start, line, Math.max(end, start + 1)));
  const d = new vscode.Diagnostic(range, p.fix ? `${p.message}\nFix: ${p.fix}` : p.message, SEVERITY[p.severity]);
  d.source = 'rizolang';
  d.code = p.code.startsWith('RZ') ? { value: p.code, target: vscode.Uri.parse(ERRORS_URL) } : p.code;
  return d;
}

// The problem back from a diagnostic this file made (for the quick fix).
function fromDiagnostic(d: vscode.Diagnostic): Problem {
  const code = typeof d.code === 'object' ? String(d.code.value) : String(d.code);
  const [message, ...rest] = d.message.split('\nFix: ');
  const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'note';
  return { severity, code, message, fix: rest.join('\nFix: '), line: d.range.start.line + 1, column: d.range.start.character + 1, length: null };
}

let instance: RizoLangChecks | undefined;

export function getRizoLangChecks(context: vscode.ExtensionContext): RizoLangChecks {
  if (!instance) {
    instance = new RizoLangChecks(context);
    context.subscriptions.push({
      dispose: () => {
        instance?.dispose();
        instance = undefined;
      },
    });
  }
  return instance;
}
