#!/usr/bin/env node
// Servidor MCP mínimo (stdio, JSON-RPC por linha) com uma ferramenta: "approve".
// O Claude Code chama essa ferramenta (via --permission-prompt-tool) antes de usar
// qualquer ferramenta que precise de permissão. Repassamos a pergunta para o app por HTTP local.
const http = require('http');

const PORT = process.env.ESTUDIO_PORT;
const TOKEN = process.env.ESTUDIO_TOKEN;
const TASK = process.env.ESTUDIO_TASK;

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function askApp(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/approve', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-estudio-token': TOKEN },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ behavior: 'deny', message: 'Resposta inválida do Estúdio.' }); }
      });
    });
    req.on('error', () => resolve({ behavior: 'deny', message: 'O Estúdio não respondeu.' }));
    req.end(body);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'estudio-aprovacoes', version: '0.1.0' },
    } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'approve',
      description: 'Pede aprovação ao usuário do Estúdio antes de usar uma ferramenta.',
      inputSchema: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
        required: ['tool_name', 'input'],
      },
    }] } });
  } else if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    const decision = await askApp({ taskId: TASK, tool_name: args.tool_name, input: args.input || {} });
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método desconhecido: ${method}` } });
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
