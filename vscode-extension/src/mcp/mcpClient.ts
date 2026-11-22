// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// A minimal MCP client (JSON-RPC 2.0) over stdio or Streamable HTTP, with
// no SDK dependency. Enough for what Rizo needs: initialize, list tools,
// call tools. No 'vscode' import: tested against a tiny fake server in
// mcpClient.test.ts.

import { spawn, type ChildProcess } from 'child_process';
import { filterEnvironment } from '../safety/commandPolicy';
import { LineDecoder, MCP_PROTOCOL_VERSION, McpServerConfig, McpTool, parseSseMessages } from './mcpProtocol';

const INIT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
export const CALL_TIMEOUT_MS = 120_000;

interface Transport {
  send(message: object): Promise<void>;
  onMessage(handler: (message: any) => void): void;
  // Called when the connection is gone for good (a local server exited).
  onClose(handler: () => void): void;
  close(): void;
  describeFailure(): string;
}

class StdioTransport implements Transport {
  private readonly child: ChildProcess;
  private handler: (m: any) => void = () => undefined;
  private stderrTail = '';
  private exited: string | undefined;
  private closeHandler: () => void = () => undefined;

  constructor(config: Extract<McpServerConfig, { kind: 'stdio' }>, envAllow: readonly string[]) {
    // The same environment as Rizo's own commands (credentials withheld)
    // plus only what this server's config sets explicitly.
    const { env } = filterEnvironment(process.env, envAllow);
    this.child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...env, ...config.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const decoder = new LineDecoder();
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (d: string) => {
      for (const m of decoder.push(d)) this.handler(m);
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.child.on('error', (err) => {
      this.exited = err.message;
      this.closeHandler();
    });
    this.child.on('exit', (code, signal) => {
      this.exited = `exited (${signal ?? code})`;
      this.closeHandler();
    });
    // A server that exits closes stdin; writing then must not crash Rizo.
    this.child.stdin?.on('error', () => undefined);
  }

  async send(message: object): Promise<void> {
    if (this.exited || !this.child.stdin?.writable) throw new Error(`the server ${this.exited ?? 'is not running'}`);
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  onMessage(handler: (m: any) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  describeFailure(): string {
    const tail = this.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return [this.exited, tail].filter(Boolean).join(': ');
  }

  close(): void {
    const pid = this.child.pid;
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* gone */
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 2000).unref();
  }
}

class HttpTransport implements Transport {
  private handler: (m: any) => void = () => undefined;
  private sessionId: string | undefined;
  private lastError = '';

  constructor(private readonly config: Extract<McpServerConfig, { kind: 'http' }>) {}

  async send(message: object): Promise<void> {
    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        ...this.config.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify(message),
      // The server must not be able to bounce Rizo to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202) return; // accepted (notifications)
    const text = await res.text();
    if (!res.ok) {
      this.lastError = `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`;
      throw new Error(this.lastError);
    }
    const type = res.headers.get('content-type') ?? '';
    const messages = type.includes('text/event-stream') ? parseSseMessages(text) : text ? [JSON.parse(text)] : [];
    for (const m of messages.flat()) this.handler(m);
  }

  onMessage(handler: (m: any) => void): void {
    this.handler = handler;
  }

  onClose(): void {
    /* each request is its own HTTP call */
  }

  describeFailure(): string {
    return this.lastError;
  }

  close(): void {
    /* stateless from Rizo's side */
  }
}

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  serverName = '';
  // True once the server exited or close() was called.
  closed = false;

  constructor(private readonly transport: Transport) {
    transport.onMessage((m) => this.handle(m));
    transport.onClose(() => {
      this.closed = true;
      const why = transport.describeFailure() || 'the server stopped';
      for (const p of [...this.pending.values()]) p.reject(new Error(`The MCP server stopped: ${why}`));
      this.pending.clear();
    });
  }

  static forConfig(config: McpServerConfig, envAllow: readonly string[] = []): McpClient {
    return new McpClient(config.kind === 'stdio' ? new StdioTransport(config, envAllow) : new HttpTransport(config));
  }

  private handle(m: any): void {
    if (!m || typeof m !== 'object') return;
    if (typeof m.id === 'number' && this.pending.has(m.id) && ('result' in m || 'error' in m)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(typeof m.error.message === 'string' ? m.error.message : 'MCP error'));
      else p.resolve(m.result);
      return;
    }
    // Requests from the server (sampling, elicitation, roots) aren't
    // supported: answer so the server doesn't wait forever.
    if (m.method && m.id !== undefined) {
      void this.transport
        .send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not supported by Rizo' } })
        .catch(() => undefined);
    }
  }

  request(method: string, params: object | undefined, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const why = this.transport.describeFailure();
        reject(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s${why ? ` (${why})` : ''}`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        void this.transport
          .send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Stopped by the user' } })
          .catch(() => undefined);
        reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.transport.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }).catch((err) => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          const why = this.transport.describeFailure();
          p.reject(new Error(`${err?.message ?? String(err)}${why ? ` (${why})` : ''}`));
        }
      });
    });
  }

  async initialize(): Promise<void> {
    const result = await this.request(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rizo', version: '0.6.0' } },
      INIT_TIMEOUT_MS,
    );
    this.serverName = typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name : '';
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS);
      for (const t of Array.isArray(result?.tools) ? result.tools : []) {
        if (t && typeof t.name === 'string') tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<any> {
    return this.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, CALL_TIMEOUT_MS, signal);
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('The MCP server was stopped.'));
    this.pending.clear();
    this.transport.close();
  }
}
