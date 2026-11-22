// End-to-end tests: run inside a real VS Code (Extension Development
// Host) started by CI (.github/workflows/ci.yml, job "End-to-end").
// Rizo talks to a fake provider on 127.0.0.1, never a real one.
// A tiny runner, no test framework: each case runs in order and a
// failure fails the run.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FakeProvider, toolNames, toolResults } from './fakeProvider';

const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
const cases: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const fake = new FakeProvider();
let api: any;
let ws: string;
let posted: any[] = [];

async function panel(): Promise<any> {
  await vscode.commands.executeCommand('rizo.openChat');
  const p = api.chatPanel();
  assert.ok(p, 'chat panel opened');
  if (!p.__wrapped) {
    const original = p.post.bind(p);
    p.post = (m: any) => {
      posted.push(m);
      original(m);
    };
    p.__wrapped = true;
  }
  return p;
}

let turnCounter = 0;
async function send(text: string, mode: 'act' | 'plan' = 'act'): Promise<string> {
  const p = await panel();
  const turnId = `e2e-${++turnCounter}`;
  await withTimeout(p.routeMessage({ type: 'send', text, turnId, mode, attachments: [] }), 60_000, `turn "${text}"`);
  return turnId;
}

const ofTurn = (turnId: string, type: string) => posted.filter((m) => m.turnId === turnId && m.type === type);

// ---------- cases ----------

test('activates in test mode and registers every command', async () => {
  const ext = vscode.extensions.getExtension('ChaitanyaAggarwal.rizo');
  assert.ok(ext, 'extension found');
  api = await ext.activate();
  assert.ok(api?.context, 'test API returned');
  const contributed: string[] = ext.packageJSON.contributes.commands.map((c: any) => c.command);
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = contributed.filter((c) => !registered.has(c));
  assert.deepStrictEqual(missing, [], 'every contributed command is registered');

  api.setOpenRouterUrl(await fake.start());
  await api.context.secrets.store('rizo.openRouterApiKey', 'sk-e2e-not-a-real-key');
});

test('the chat view loads under its Content Security Policy', async () => {
  const p = await panel();
  // chat.js sends "ready" once it has run; a CSP or script error would stop it.
  await withTimeout(p.ready, 30_000, 'chat view ready');
});

test('a reply streams and is saved', async () => {
  const p = await panel();
  await p.routeMessage({ type: 'selectProvider', provider: 'claude' });
  fake.reset(() => ({ text: 'Hello from the fake model.' }));
  const turnId = await send('Say hello');
  assert.strictEqual(fake.requests.length, 1);
  assert.ok(String(fake.requests[0].model).startsWith('anthropic/'), `model stays on Claude (${fake.requests[0].model})`);
  const deltas = ofTurn(turnId, 'textDelta').map((m) => m.text).join('');
  assert.strictEqual(deltas, 'Hello from the fake model.');
  assert.deepStrictEqual(ofTurn(turnId, 'error'), []);
});

test('search tools run without approval and never search .env files', async () => {
  fs.writeFileSync(path.join(ws, 'app.ts'), 'export const greeting = "needle";\n');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET_TOKEN=needle-in-env\n');
  fake.reset((_body, i) =>
    i === 0 ? { tool: 'search_files', args: { pattern: 'needle' } } : i === 1 ? { tool: 'read_file', args: { path: 'app.ts' } } : { text: 'Found it in app.ts.' },
  );
  const turnId = await send('Where is needle?');
  assert.strictEqual(fake.requests.length, 3);
  const searchResult = toolResults(fake.requests[1]).at(-1) ?? '';
  assert.match(searchResult, /app\.ts:1/);
  assert.doesNotMatch(searchResult, /needle-in-env/);
  assert.match(toolResults(fake.requests[2]).at(-1) ?? '', /greeting/);
  const ends = ofTurn(turnId, 'toolEnd');
  assert.strictEqual(ends.length, 2);
  assert.ok(ends.every((e) => e.ok), 'both tool calls succeeded');
});

test('plan mode offers only read-only tools and refuses writes', async () => {
  fake.reset((_body, i) => (i === 0 ? { tool: 'write_file', args: { path: 'plan.txt', content: 'x' } } : { text: 'Here is the plan.' }));
  await send('Plan a change', 'plan');
  const offered = toolNames(fake.requests[0]);
  for (const t of ['write_file', 'edit_file', 'run_command']) assert.ok(!offered.includes(t), `${t} not offered in plan mode`);
  assert.ok(offered.includes('read_file') && offered.includes('search_files'));
  assert.match(toolResults(fake.requests[1]).at(-1) ?? '', /plan mode is on/);
  assert.ok(!fs.existsSync(path.join(ws, 'plan.txt')), 'nothing written');
});

test('an approved write is applied and can be undone', async () => {
  // "Always Allow (this project)" for edits, as if the user had chosen it.
  await api.context.workspaceState.update('rizo.alwaysAllowFileEdits', true);
  fake.reset((_body, i) =>
    i === 0 ? { tool: 'write_file', args: { path: 'notes.md', content: '# Notes\n' } } : { text: 'Created notes.md.' },
  );
  const turnId = await send('Create notes.md');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8'), '# Notes\n');
  // The finished reply carries the files its Undo button restores.
  const done = posted.find((m) => m.turnId === turnId && Array.isArray(m.checkpointFiles) && m.checkpointFiles.length);
  assert.ok(done, 'the reply offers Undo changes');
  assert.deepStrictEqual(done.checkpointFiles, ['notes.md']);
  await api.context.workspaceState.update('rizo.alwaysAllowFileEdits', undefined);
});

test('MCP: tools from a configured server are offered and called', async () => {
  const fakeServer = path.join(api.context.extensionPath, 'src', 'mcp', 'testdata', 'fakeServer.js');
  await vscode.workspace
    .getConfiguration('rizo')
    .update('mcp.servers', { fake: { command: process.execPath, args: [fakeServer] } }, vscode.ConfigurationTarget.Global);
  await api.context.workspaceState.update('rizo.mcp.alwaysAllow', ['fake/echo']);
  fake.reset((_body, i) => (i === 0 ? { tool: 'mcp__fake__echo', args: { hello: 'mcp' } } : { text: 'MCP worked.' }));
  await send('Use the echo tool');
  assert.ok(toolNames(fake.requests[0]).includes('mcp__fake__echo'), 'MCP tool offered');
  const result = toolResults(fake.requests[1]).at(-1) ?? '';
  assert.match(result, /untrusted/);
  assert.match(result, /"hello":"mcp"/);

  fake.reset(() => ({ text: 'plan' }));
  await send('Plan with MCP', 'plan');
  assert.ok(!toolNames(fake.requests[0]).some((n: string) => n.startsWith('mcp__')), 'no MCP tools in plan mode');
  await vscode.workspace.getConfiguration('rizo').update('mcp.servers', undefined, vscode.ConfigurationTarget.Global);
});

test('inline edit rewrites the selection in place', async () => {
  const file = path.join(ws, 'math.ts');
  fs.writeFileSync(file, 'export function add(a, b) {\n  return a + b;\n}\n');
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(0, 0, 2, 1);
  fake.reset(() => ({ text: '```ts\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```' }));
  void vscode.commands.executeCommand('rizo.inlineEdit', { instruction: 'Add types' });
  await waitFor(() => doc.getText().includes('a: number'), 30_000, 'the inline edit');
  assert.strictEqual(doc.getText(), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  assert.match(JSON.stringify(fake.requests[0].messages[1].content), /<selection>/);
  await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
  await vscode.commands.executeCommand('workbench.action.files.revert');
});

test('autocomplete suggests a completion and skips secret files', async () => {
  await vscode.workspace.getConfiguration('rizo').update('autocomplete.enabled', true, vscode.ConfigurationTarget.Global);
  const provider = api.completionProvider();
  const token = new vscode.CancellationTokenSource().token;
  const ctx = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };

  const file = path.join(ws, 'sum.ts');
  fs.writeFileSync(file, 'const total = ');
  const doc = await vscode.workspace.openTextDocument(file);
  fake.reset(() => ({ text: 'items.length;' }));
  const items = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 14), ctx, token);
  assert.strictEqual(items?.[0]?.insertText, 'items.length;');

  const envDoc = await vscode.workspace.openTextDocument(path.join(ws, '.env'));
  fake.reset(() => ({ text: 'leak' }));
  const none = await provider.provideInlineCompletionItems(envDoc, new vscode.Position(0, 5), ctx, token);
  assert.strictEqual(none, undefined);
  assert.strictEqual(fake.requests.length, 0, '.env never sent');
  await vscode.workspace.getConfiguration('rizo').update('autocomplete.enabled', undefined, vscode.ConfigurationTarget.Global);
});

test('protected folders still ask even with Always Allow on', async () => {
  await api.context.workspaceState.update('rizo.alwaysAllowFileEdits', true);
  fake.reset((_body, i) =>
    i === 0 ? { tool: 'write_file', args: { path: '.vscode/settings.json', content: '{}' } } : { text: 'done' },
  );
  const p = await panel();
  const turnId = `e2e-${++turnCounter}`;
  const running = p.routeMessage({ type: 'send', text: 'Change settings', turnId, mode: 'act', attachments: [] });
  // The approval dialog blocks; the file must not appear. Then Stop.
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(!fs.existsSync(path.join(ws, '.vscode', 'settings.json')), 'protected file not written without asking');
  await p.routeMessage({ type: 'cancel', turnId });
  await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
  void running.catch(() => undefined);
  await api.context.workspaceState.update('rizo.alwaysAllowFileEdits', undefined);
});

test('.rz files open as Rizo Lang', async () => {
  const file = path.join(ws, 'app.rz');
  fs.writeFileSync(file, 'auth User by email\n\nmodel User {\n  email: Email unique private\n  password: Password min 12\n}\n');
  const doc = await vscode.workspace.openTextDocument(file);
  assert.strictEqual(doc.languageId, 'rizolang');
  assert.ok((await vscode.languages.getLanguages()).includes('rizolang'));
});

// Runs last: the approval dialog it opens stays open.

// ---------- runner ----------

export async function run(): Promise<void> {
  ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  assert.ok(ws, 'a workspace folder is open');
  for (const c of cases) {
    const start = Date.now();
    try {
      await c.fn();
      results.push({ name: c.name, ok: true, ms: Date.now() - start });
      console.log(`  ✓ ${c.name} (${Date.now() - start} ms)`);
    } catch (err: any) {
      results.push({ name: c.name, ok: false, error: err?.stack ?? String(err), ms: Date.now() - start });
      console.log(`  ✗ ${c.name}\n${err?.stack ?? err}`);
    }
  }
  fake.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  const out = process.env.RIZO_E2E_RESULTS;
  if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
  if (failed.length) throw new Error(`${failed.length} end-to-end test(s) failed`);
}
