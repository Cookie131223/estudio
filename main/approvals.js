// Aprovações: o Claude Code pergunta ao nosso servidor MCP (approval-mcp.js) antes de cada ferramenta
// que não é só leitura. O servidor MCP repassa por HTTP local para cá, e aqui decidimos:
// liberar sozinho (de acordo com o nível de autonomia) ou tocar o telefone e esperar o usuário.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { describeTool } = require('./providers');

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Task', 'ExitPlanMode', 'BashOutput']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

const DESTRUCTIVE = [
  /\brm\s+-\w*[rf]/i, /\brm\s+.*\*/i, /\brmdir\b/i, /\brd\s+\/s/i, /\bdel(ete)?\s+\/[sq]/i, /\berase\b/i,
  /Remove-Item\b/i, /\bformat\s+[a-z]:/i, /\bmkfs/i, /\bdd\s+if=/i, /\bshutdown\b/i, /\breg\s+delete\b/i,
  /git\s+push\b.*(--force|-f\b)/i, /git\s+reset\s+--hard/i, /git\s+clean\s+-\w*f/i, /git\s+branch\s+-D/i,
  /git\s+checkout\s+--\s/i, /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+table\b/i,
  /\bnpm\s+publish\b/i, /\bchmod\s+-R\s+777/i, /:\(\)\s*\{/,
];

function isDestructive(cmd) {
  return DESTRUCTIVE.some((re) => re.test(String(cmd || '')));
}

function inside(cwd, p) {
  if (!p) return true;
  const root = path.resolve(cwd);
  const full = path.resolve(cwd, String(p));
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? full.toLowerCase() : full;
  return b === a || b.startsWith(a + path.sep);
}

/**
 * Decide se a ferramenta pode rodar sem perguntar.
 * autonomy: 'ask' (perguntar tudo) | 'edits' (aceitar edições) | 'auto' (trabalhar sozinho)
 * Retorna { decision: 'allow' | 'ask', reason }
 */
function policy(autonomy, toolName, input, cwd) {
  const i = input || {};
  const file = i.file_path || i.path || i.notebook_path;
  if (file && !inside(cwd, file)) return { decision: 'ask', reason: 'Fora da pasta do projeto' };
  if (READ_TOOLS.has(toolName)) return { decision: 'allow' };
  if (EDIT_TOOLS.has(toolName)) {
    return autonomy === 'ask' ? { decision: 'ask', reason: 'Quer editar um arquivo' } : { decision: 'allow' };
  }
  if (toolName === 'Bash') {
    if (isDestructive(i.command)) return { decision: 'ask', reason: 'Comando destrutivo' };
    return autonomy === 'auto' ? { decision: 'allow' } : { decision: 'ask', reason: 'Quer rodar um comando' };
  }
  if (WEB_TOOLS.has(toolName)) {
    return autonomy === 'auto' ? { decision: 'allow' } : { decision: 'ask', reason: 'Quer acessar a web' };
  }
  return autonomy === 'auto' ? { decision: 'allow' } : { decision: 'ask', reason: 'Ferramenta externa' };
}

class Approvals {
  /**
   * getContext(taskId) -> { autonomy, cwd, agentId } | null
   * onRequest(req) é chamado quando o usuário precisa decidir.
   */
  constructor({ getContext, onRequest, onResolved, onAuto }) {
    this.getContext = getContext;
    this.onRequest = onRequest || (() => {});
    this.onResolved = onResolved || (() => {});
    this.onAuto = onAuto || (() => {});
    this.pending = new Map();
    this.token = crypto.randomBytes(16).toString('hex');
    this.port = 0;
  }

  start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  stop() { try { this.server.close(); } catch {} }

  _handle(req, res) {
    if (req.method !== 'POST' || req.url !== '/approve' || req.headers['x-estudio-token'] !== this.token) {
      res.writeHead(403); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const decision = await this.decide(data);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision));
    });
    // Se o processo do agente morrer, a conexão cai: cancelamos o pedido pendente.
    res.on('close', () => {
      for (const [id, p] of this.pending) if (p.res === res) this._finish(id, 'deny', 'cancelado');
    });
  }

  async decide({ taskId, tool_name: tool, input }) {
    const ctx = this.getContext(taskId);
    if (!ctx) return { behavior: 'deny', message: 'A tarefa foi interrompida pelo usuário.' };
    const pol = policy(ctx.autonomy, tool, input, ctx.cwd);
    if (pol.decision === 'allow') {
      this.onAuto({ taskId, agentId: ctx.agentId, tool, summary: describeTool(tool, input) });
      return { behavior: 'allow', updatedInput: input };
    }
    const id = crypto.randomBytes(6).toString('hex');
    const req = {
      id, taskId, agentId: ctx.agentId, tool, input,
      summary: describeTool(tool, input), reason: pol.reason,
      command: input && input.command, file: input && (input.file_path || input.path),
    };
    return new Promise((resolve) => {
      this.pending.set(id, { req, resolve });
      this.onRequest(req);
    }).then((d) => (d === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'O usuário negou esta ação. Siga sem ela ou explique o que precisaria.' }));
  }

  /** decision: 'allow' | 'deny' */
  answer(id, decision) { return this._finish(id, decision, 'usuário'); }

  _finish(id, decision, by) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(decision);
    this.onResolved({ id, agentId: p.req.agentId, taskId: p.req.taskId, decision, by });
    return true;
  }

  /** Nega tudo que está pendente (botão Parar ou tarefa encerrada). */
  denyAll(filter = () => true) {
    for (const [id, p] of [...this.pending]) if (filter(p.req)) this._finish(id, 'deny', 'parar');
  }

  /** Arquivo de configuração MCP que o Claude Code usa para chamar a aprovação. */
  mcpConfig({ taskId, nodePath, scriptPath }) {
    return {
      mcpServers: {
        estudio: {
          command: nodePath,
          args: [scriptPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            ESTUDIO_PORT: String(this.port),
            ESTUDIO_TOKEN: this.token,
            ESTUDIO_TASK: String(taskId),
          },
        },
      },
    };
  }
}

module.exports = { Approvals, policy, isDestructive, inside };
