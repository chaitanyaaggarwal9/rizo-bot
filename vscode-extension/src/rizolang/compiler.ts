// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Finds the project's own Rizo Lang compiler (node_modules/rizolang) and
// runs `rizolang audit <file> --json` on a copy of a .rz file in a private
// temporary folder, so the project is never written to and unsaved edits
// can be checked. Only audit is ever run: it compiles and reviews the file
// but writes nothing. No 'vscode' import: tested in compiler.test.ts.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filterEnvironment } from '../safety/commandPolicy';
import { AuditResult, parseAuditOutput } from './auditOutput';

export interface Compiler {
  packageDir: string; // real path of node_modules/rizolang
  bin: string; // real path of its bin script, inside packageDir
  version: string;
}

const AUDIT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 2_000_000;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The nearest node_modules/rizolang from the file's folder up to (and
// including) the workspace folder. Never looks above the workspace.
export function findCompiler(fileDir: string, workspaceRoot: string): Compiler | undefined {
  let dir = path.resolve(fileDir);
  const root = path.resolve(workspaceRoot);
  if (dir !== root && !isInside(dir, root)) return undefined;
  for (;;) {
    const found = readCompiler(path.join(dir, 'node_modules', 'rizolang'));
    if (found) return found;
    if (dir === root) return undefined;
    dir = path.dirname(dir);
  }
}

function readCompiler(pkgPath: string): Compiler | undefined {
  try {
    const packageDir = fs.realpathSync(pkgPath);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (pkg?.name !== 'rizolang' || typeof pkg.version !== 'string') return undefined;
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.rizolang;
    if (typeof binRel !== 'string') return undefined;
    // The bin must stay inside the package, even through symlinks.
    const bin = fs.realpathSync(path.join(packageDir, binRel));
    if (!isInside(bin, packageDir) || !fs.statSync(bin).isFile()) return undefined;
    return { packageDir, bin, version: pkg.version.slice(0, 40) };
  } catch {
    return undefined;
  }
}

// A stable identity for "the user allowed this compiler in this project".
export function compilerKey(c: Compiler): string {
  return `${c.bin}@${c.version}`;
}

interface RunOptions {
  envAllow?: readonly string[];
  signal?: AbortSignal;
  // For tests: the Node.js to run the compiler with.
  node?: string;
}

function runNode(node: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string; code: number | null; missing?: boolean }>((resolve) => {
    const child = spawn(node, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: { stdout: string; stderr: string; code: number | null; missing?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ stdout, stderr: `${stderr}\nTimed out after ${AUDIT_TIMEOUT_MS / 1000}s.`, code: null });
    }, AUDIT_TIMEOUT_MS);
    const onAbort = () => {
      kill();
      finish({ stdout: '', stderr: 'Stopped.', code: null });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT) kill();
    });
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (err: NodeJS.ErrnoException) => finish({ stdout, stderr: err.message, code: null, missing: err.code === 'ENOENT' }));
    child.on('close', (code) => finish({ stdout, stderr, code }));
  });
}

// Audits `source` as `fileName` (a bare name ending in .rz).
export async function runAudit(compiler: Compiler, source: string, fileName: string, opts: RunOptions = {}): Promise<AuditResult | { error: string }> {
  const name = path.basename(fileName);
  if (!name.endsWith('.rz')) return { error: 'Only .rz files can be checked.' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizo-rz-'));
  try {
    fs.writeFileSync(path.join(dir, name), source, { mode: 0o600, flag: 'wx' });
    const { env } = filterEnvironment(process.env, opts.envAllow ?? []);
    const args = [compiler.bin, 'audit', name, '--json'];
    let r = await runNode(opts.node ?? 'node', args, dir, env, opts.signal);
    // No `node` on PATH: run it with the editor's own Node.js instead.
    if (r.missing && !opts.node) {
      r = await runNode(process.execPath, args, dir, { ...env, ELECTRON_RUN_AS_NODE: '1' }, opts.signal);
    }
    if (opts.signal?.aborted) return { error: 'Stopped.' };
    const parsed = parseAuditOutput(r.stdout);
    if ('error' in parsed) {
      const why = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      return { error: `${parsed.error}${why ? ` ${why}` : ''}` };
    }
    return parsed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
