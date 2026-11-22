// A tiny MCP server over stdio, used only by mcpClient.test.ts.
let buffer = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue; // notifications
    switch (m.method) {
      case 'initialize':
        process.stdout.write('a log line that is not JSON\n');
        send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'fake' }, capabilities: { tools: {} } } });
        break;
      case 'tools/list':
        if (!m.params.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }], nextCursor: 'p2' } });
        else send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'env' }, { name: 'hang' }] } });
        break;
      case 'tools/call':
        if (m.params.name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(m.params.arguments) }] } });
        else if (m.params.name === 'env') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${process.env.FAKE_SECRET_TOKEN ?? 'none'} ${process.env.FROM_CONFIG ?? 'none'}` }] } });
        else if (m.params.name === 'hang') { /* never answers */ }
        else send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } });
        break;
      default:
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
