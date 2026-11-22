// A fake OpenRouter for the end-to-end tests: an HTTP server on
// 127.0.0.1 that answers chat-completions requests with scripted,
// streamed (SSE) replies and records every request body.

import * as http from 'http';
import type { AddressInfo } from 'net';

export type Reply = { text: string } | { tool: string; args: unknown };
export type Script = (body: any, index: number) => Reply;

export class FakeProvider {
  readonly requests: any[] = [];
  private server?: http.Server;
  script: Script = () => ({ text: 'ok' });

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: any = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* recorded as {} */
        }
        const index = this.requests.length;
        this.requests.push(body);
        const reply = this.script(body, index);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if ('text' in reply) {
          // Two chunks, to exercise streaming.
          const half = Math.ceil(reply.text.length / 2);
          send({ model: body.model, choices: [{ delta: { content: reply.text.slice(0, half) } }] });
          send({ model: body.model, choices: [{ delta: { content: reply.text.slice(half) } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0002 } });
        } else {
          send({
            model: body.model,
            choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${index}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } }],
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0002 } });
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1/chat/completions`;
  }

  reset(script: Script): void {
    this.requests.length = 0;
    this.script = script;
  }

  stop(): void {
    this.server?.close();
  }
}

// The text of every tool result the model was sent in a request.
export function toolResults(body: any): string[] {
  return (body?.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
}

export function toolNames(body: any): string[] {
  return (body?.tools ?? []).map((t: any) => t.function?.name);
}
