// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Runs the MCP servers the user configured (rizo.mcp.servers, a user
// setting that a workspace can't set), offers their tools to the model,
// and asks the user before every call.
//
// Security rules:
// - Servers come only from the user's own settings, never from the
//   workspace, so opening a repo can't start a program.
// - Every tool call is approved by the user (once, or "always" for that one
//   tool in this workspace). A server's claim that a tool is read-only is
//   ignored.
// - Results are marked as untrusted, secrets in them are redacted, and
//   their size is capped (mcpProtocol.formatToolResult).
// - Local servers get the same environment as Rizo's commands (credential
//   variables withheld) plus only the "env" set in their config.
// - MCP tools are never offered in Plan mode (chatPanel.ts).

import * as vscode from 'vscode';
import type { ToolDefinition } from '../tools/tools';
import { McpClient } from './mcpClient';
import {
  describeArguments,
  formatToolResult,
  McpTool,
  parseServerConfigs,
  ParsedServer,
  toToolDefinition,
} from './mcpProtocol';

const ALWAYS_ALLOW_KEY = 'rizo.mcp.alwaysAllow';
// More tools than this crowd the model's context; the rest are skipped.
const MAX_MCP_TOOLS = 80;

interface RunningServer {
  name: string;
  configKey: string; // the config it was started with, to spot changes
  client?: McpClient;
  tools: McpTool[];
  error?: string;
  starting?: Promise<void>;
}

export class McpManager implements vscode.Disposable {
  private readonly servers = new Map<string, RunningServer>();
  // Qualified tool name -> where it came from.
  private readonly toolIndex = new Map<string, { server: string; tool: string }>();
  private readonly warned = new Set<string>();
  private readonly configListener: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('rizo.mcp.servers')) this.stopAll();
    });
  }

  // Only the user-level value: even if a workspace somehow set it, it's ignored.
  private configured(): { servers: ParsedServer[]; errors: string[] } {
    const inspected = vscode.workspace.getConfiguration('rizo').inspect<unknown>('mcp.servers');
    return parseServerConfigs(inspected?.globalValue);
  }

  hasServers(): boolean {
    return this.configured().servers.length > 0;
  }

  private async start(server: ParsedServer): Promise<RunningServer> {
    const configKey = JSON.stringify(server.config);
    const existing = this.servers.get(server.name);
    // Reused unless its config changed or a running server has since exited
    // (a server that failed to start stays failed until "Restart all").
    if (existing && existing.configKey === configKey && (existing.error || !existing.client?.closed)) {
      await existing.starting;
      return existing;
    }
    existing?.client?.close();
    const entry: RunningServer = { name: server.name, configKey, tools: [] };
    this.servers.set(server.name, entry);
    entry.starting = (async () => {
      const envAllow = vscode.workspace.getConfiguration('rizo').get<string[]>('permissions.passEnvironmentVariables', []);
      const config =
        server.config.kind === 'stdio' && !server.config.cwd
          ? { ...server.config, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }
          : server.config;
      try {
        const client = McpClient.forConfig(config, envAllow);
        entry.client = client;
        await client.initialize();
        entry.tools = await client.listTools();
      } catch (err: any) {
        entry.error = err?.message ?? String(err);
        entry.client?.close();
        entry.client = undefined;
      }
    })();
    await entry.starting;
    return entry;
  }

  // The tools of every configured server, starting servers that aren't
  // running yet. A server that fails is reported once and left out.
  async toolDefinitions(): Promise<ToolDefinition[]> {
    const { servers, errors } = this.configured();
    for (const e of errors) this.warnOnce(`config:${e}`, `Rizo MCP settings: ${e}`);
    // Servers removed from the settings are stopped.
    for (const name of [...this.servers.keys()]) {
      if (!servers.some((s) => s.name === name)) this.stop(name);
    }
    const started = await Promise.all(servers.map((s) => this.start(s)));
    this.toolIndex.clear();
    const defs: ToolDefinition[] = [];
    for (const s of started) {
      if (s.error) {
        this.warnOnce(`start:${s.name}:${s.error}`, `Rizo couldn't start the MCP server "${s.name}": ${s.error}. After fixing it, run "Rizo: Show MCP Servers" and restart.`);
        continue;
      }
      for (const tool of s.tools) {
        const def = toToolDefinition(s.name, tool);
        const qualified = def.function.name;
        if (this.toolIndex.has(qualified)) continue; // a name clash after sanitizing
        if (defs.length >= MAX_MCP_TOOLS) {
          this.warnOnce('too-many', `Rizo offers at most ${MAX_MCP_TOOLS} MCP tools per chat; disable servers you don't need.`);
          break;
        }
        this.toolIndex.set(qualified, { server: s.name, tool: tool.name });
        defs.push(def);
      }
    }
    return defs;
  }

  isMcpTool(name: string): boolean {
    return this.toolIndex.has(name);
  }

  // Asks the user, then calls the tool. Always returns text for the model;
  // failures start with "Error:".
  async callTool(qualifiedName: string, argsJson: string, signal?: AbortSignal): Promise<string> {
    const target = this.toolIndex.get(qualifiedName);
    if (!target) return `Error: the MCP tool "${qualifiedName}" isn't available (its server may have stopped).`;
    let args: unknown;
    try {
      args = argsJson.trim() ? JSON.parse(argsJson) : {};
    } catch (err: any) {
      return `Error: could not parse tool arguments as JSON (${err?.message ?? String(err)}).`;
    }
    if (!(await this.approve(target.server, target.tool, argsJson))) {
      return `Error: the user declined this call to "${target.tool}" on MCP server "${target.server}".`;
    }
    if (signal?.aborted) return 'Error: stopped by the user.';
    const entry = this.servers.get(target.server);
    if (!entry?.client) return `Error: the MCP server "${target.server}" isn't running.`;
    try {
      const result = await entry.client.callTool(target.tool, args, signal);
      return formatToolResult(target.server, result);
    } catch (err: any) {
      return `Error: MCP server "${target.server}" failed: ${err?.message ?? String(err)}`;
    }
  }

  private alwaysAllowed(): string[] {
    return this.context.workspaceState.get<string[]>(ALWAYS_ALLOW_KEY, []);
  }

  private async approve(server: string, tool: string, argsJson: string): Promise<boolean> {
    const key = `${server}/${tool}`;
    if (this.alwaysAllowed().includes(key)) return true;
    const once = 'Allow once';
    const always = 'Always allow this tool here';
    const choice = await vscode.window.showWarningMessage(
      `Allow Rizo to use "${tool}" from the MCP server "${server}"?`,
      {
        modal: true,
        detail: `MCP tools run outside Rizo's own safety checks and may change things (files, issues, data in other services).\n\nArguments:\n${describeArguments(argsJson)}`,
      },
      once,
      always,
    );
    if (choice === always) {
      await this.context.workspaceState.update(ALWAYS_ALLOW_KEY, [...this.alwaysAllowed(), key]);
      return true;
    }
    return choice === once;
  }

  // "Rizo: Show MCP Servers": status of each server, its tools, and a way
  // to restart servers or forget "always allow" choices.
  async showServers(): Promise<void> {
    const { servers, errors } = this.configured();
    if (!servers.length && !errors.length) {
      const add = 'Add MCP Server';
      const pick = await vscode.window.showInformationMessage('No MCP servers are set up. Add one in your user settings (rizo.mcp.servers).', add);
      if (pick === add) await this.addServer();
      return;
    }
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Rizo: checking MCP servers...' },
      () => Promise.all(servers.map((s) => this.start(s))),
    );
    type Item = vscode.QuickPickItem & { action?: 'restart' | 'forget' | 'settings' };
    const items: Item[] = started.map((s) => ({
      label: `${s.error ? '$(error)' : '$(check)'} ${s.name}`,
      description: s.error ? 'failed to start' : `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`,
      detail: s.error ?? (s.tools.map((t) => t.name).join(', ') || 'no tools'),
    }));
    for (const e of errors) items.push({ label: '$(warning) Settings problem', detail: e });
    const allowed = this.alwaysAllowed();
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(debug-restart) Restart all servers', action: 'restart' });
    if (allowed.length) {
      items.push({ label: `$(shield) Forget "always allow" choices for this workspace`, description: allowed.join(', '), action: 'forget' });
    }
    items.push({ label: '$(gear) Open MCP settings', action: 'settings' });
    const pick = await vscode.window.showQuickPick(items, { title: 'Rizo MCP servers', matchOnDetail: true });
    if (pick?.action === 'restart') {
      this.stopAll();
      await this.showServers();
    } else if (pick?.action === 'forget') {
      await this.context.workspaceState.update(ALWAYS_ALLOW_KEY, []);
      void vscode.window.showInformationMessage('Rizo will ask again before every MCP tool call in this workspace.');
    } else if (pick?.action === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'rizo.mcp.servers' } });
    }
  }

  // "Rizo: Add MCP Server": a short guided setup that writes the user setting.
  async addServer(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'Add MCP server (1/2)',
      prompt: 'A short name for the server, for example "github" or "docs"',
      validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v) && !v.includes('__') ? undefined : 'Letters, digits, - and single _ only (max 32).'),
    });
    if (!name) return;
    const target = await vscode.window.showInputBox({
      title: 'Add MCP server (2/2)',
      prompt: 'The command that starts a local server (for example: npx -y @modelcontextprotocol/server-github), or the https URL of a remote one',
      ignoreFocusOut: true,
    });
    if (!target?.trim()) return;
    const value = target.trim();
    let entry: Record<string, unknown>;
    if (/^https?:\/\//i.test(value)) {
      entry = { url: value };
    } else {
      // Simple whitespace split; quote-heavy commands are easier to edit in settings.json.
      const [command, ...args] = value.split(/\s+/);
      entry = { command, args };
    }
    const parsed = parseServerConfigs({ [name]: entry });
    if (parsed.errors.length) {
      void vscode.window.showErrorMessage(parsed.errors[0]);
      return;
    }
    const config = vscode.workspace.getConfiguration('rizo');
    const current = (config.inspect<Record<string, unknown>>('mcp.servers')?.globalValue ?? {}) as Record<string, unknown>;
    if (current[name] && !(await confirm(`Replace the existing MCP server "${name}"?`))) return;
    await config.update('mcp.servers', { ...current, [name]: entry }, vscode.ConfigurationTarget.Global);
    const open = 'Open settings';
    const pick = await vscode.window.showInformationMessage(
      `Added the MCP server "${name}". It starts with your next message. Add API keys it needs under "env" (local) or "headers" (remote) in your user settings.`,
      open,
    );
    if (pick === open) {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'rizo.mcp.servers' } });
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    void vscode.window.showWarningMessage(message);
  }

  private stop(name: string): void {
    this.servers.get(name)?.client?.close();
    this.servers.delete(name);
  }

  stopAll(): void {
    for (const name of [...this.servers.keys()]) this.stop(name);
    this.toolIndex.clear();
    this.warned.clear();
  }

  dispose(): void {
    this.stopAll();
    this.configListener.dispose();
  }
}

async function confirm(message: string): Promise<boolean> {
  const yes = 'Replace';
  return (await vscode.window.showWarningMessage(message, { modal: true }, yes)) === yes;
}

let instance: McpManager | undefined;

// One manager for the extension; disposed (servers stopped) on deactivate.
export function getMcpManager(context: vscode.ExtensionContext): McpManager {
  if (!instance) {
    instance = new McpManager(context);
    context.subscriptions.push({ dispose: () => { instance?.dispose(); instance = undefined; } });
  }
  return instance;
}

