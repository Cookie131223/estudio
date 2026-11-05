#!/usr/bin/env node
// Estúdio no navegador.
//  - No PC: servidor local em http://localhost:4747 (só o próprio PC acessa).
//  - Online (Railway): ESTUDIO_ONLINE=1, escuta na porta PORT e pede senha (ESTUDIO_PASSWORD).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const ONLINE = !!process.env.ESTUDIO_ONLINE;
const DATA_DIR = process.env.ESTUDIO_DATA || (ONLINE ? '/data' : path.join(os.homedir(), '.estudio-agentes'));
if (ONLINE) {
  // Logins dos CLIs (~/.codex, ~/.claude, ~/.git-credentials…) ficam no volume e sobrevivem a novos deploys.
  process.env.HOME = path.join(DATA_DIR, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
}
const { createCore } = require('./main/core');
const { createOnline } = require('./main/online');

const PORT = Number(ONLINE ? process.env.PORT || 8080 : process.env.ESTUDIO_PORT || 4747);
const HOST = ONLINE ? '0.0.0.0' : '127.0.0.1';
const ROOT = __dirname;
const URL_BASE = `http://localhost:${PORT}`;
if (!process.env.ESTUDIO_LOG_DIR) process.env.ESTUDIO_LOG_DIR = ONLINE ? path.join(DATA_DIR, 'logs') : path.join(ROOT, 'logs');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const STATIC_DIRS = [path.join(ROOT, 'renderer'), path.join(ROOT, 'node_modules', 'three')];

const clients = new Set();
function send(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}

function openBrowser(url) {
  if (process.env.ESTUDIO_NO_BROWSER || ONLINE) return;
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 12e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function json(res, code, data, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data === undefined ? null : data));
}

function serveFile(res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  });
}

function serveStatic(req, res) {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') { res.writeHead(302, { location: '/renderer/index.html' }); return res.end(); }
  const full = path.normalize(path.join(ROOT, p));
  if (!STATIC_DIRS.some((d) => full === d || full.startsWith(d + path.sep))) { res.writeHead(404); return res.end(); }
  serveFile(res, full);
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

(async () => {
  if (!ONLINE) {
    // Já tem um Estúdio rodando? Só abre o navegador.
    const already = await new Promise((resolve) => {
      const r = http.get({ host: HOST, port: PORT, path: '/api/ping', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on('error', () => resolve(false));
      r.on('timeout', () => { r.destroy(); resolve(false); });
    });
    if (already) {
      console.log(`O Estúdio já está aberto. Abrindo ${URL_BASE} ...`);
      openBrowser(URL_BASE);
      setTimeout(() => process.exit(0), 500);
      return;
    }
  } else if (!process.env.ESTUDIO_PASSWORD) {
    console.warn('Aviso: ESTUDIO_PASSWORD não definida. Ninguém consegue entrar até você definir uma senha nas variáveis do Railway.');
  }

  const core = await createCore({ dataDir: path.join(DATA_DIR, 'dados'), send });
  const online = ONLINE ? createOnline({ store: core.store, send, core, dataDir: DATA_DIR }) : null;

  const routes = {
    'GET /api/ping': () => ({ ok: true }),
    'GET /api/state': () => ({ ...core.snapshot(), online: ONLINE, accounts: online ? online.accounts() : null }),
    'POST /api/settings': (b) => core.store.setSettings(b || {}),
    'POST /api/agent/save': (b) => { const r = core.store.upsertAgent(b); send({ kind: 'agents', agents: core.store.agents }); return r; },
    'POST /api/agent/delete': (b) => { core.store.deleteAgent(b.id); send({ kind: 'agents', agents: core.store.agents }); return true; },
    'POST /api/folder/pick': () => (ONLINE ? { online: true } : core.pickFolderNative()),
    'POST /api/folder/set': (b) => ({ path: core.setProjectDir(b.path) }),
    'POST /api/folder/open': () => (ONLINE ? { error: 'No online, os arquivos ficam no servidor.' } : core.openFolder()),
    'POST /api/ask': (b) => { core.orch.ask(b); return true; },
    'POST /api/stop': () => core.orch.stop(),
    'POST /api/answer': (b) => core.approvals.answer(b.id, b.decision === 'allow' ? 'allow' : 'deny'),
    'POST /api/detect': () => core.detectProviders(),
    'POST /api/test': (b) => core.testProvider(b.key),
    'POST /api/login': (b) => (ONLINE ? { online: true } : core.openLogin(b.key)),
    'POST /api/voice': (b) => core.voice(b.op, b),
    'POST /api/copilot/tip': (b) => core.copilot.tip(b),
    'POST /api/copilot/control': (b) => (ONLINE ? { on: false, error: 'Controlar mouse e teclado só funciona no Estúdio do seu PC.' } : core.copilot.setControl(!!b.on)),
    'POST /api/copilot/act': (b) => (ONLINE ? { ok: false, error: 'Só no Estúdio do PC.' } : core.copilot.act(b.acao || {})),
    'GET /api/copilot/status': () => core.copilot.status(),
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];

    if (!ONLINE) {
      // Só aceita pedidos feitos para localhost (protege contra sites maliciosos).
      const host = String(req.headers.host || '').toLowerCase();
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { res.writeHead(403); return res.end(); }
    } else {
      // Online: tudo exige estar logado, menos a tela de senha.
      if (urlPath === '/login' || urlPath === '/login.html') return serveFile(res, path.join(ROOT, 'renderer', 'login.html'));
      if (urlPath === '/api/ping') return json(res, 200, { ok: true, login: true });
      if (urlPath === '/api/session' && req.method === 'POST') {
        if (req.headers['x-estudio'] !== '1') return json(res, 403, { error: 'proibido' });
        const b = await readBody(req);
        const r = online.login(b.password, clientIp(req));
        if (r.error) return json(res, 401, r);
        return json(res, 200, { ok: true }, { 'set-cookie': `estudio_sess=${r.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` });
      }
      if (!online.validSession(req.headers.cookie)) {
        if (urlPath.startsWith('/api/')) return json(res, 401, { error: 'login', login: true });
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      res.setHeader('x-frame-options', 'DENY');
    }

    if (urlPath === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (urlPath.startsWith('/api/')) {
      let fn = routes[`${req.method} ${urlPath}`];
      const om = urlPath.match(/^\/api\/online\/(\w+)$/);
      if (!fn && om && online && online.handlers[om[1]] && req.method === 'POST') fn = (b) => online.handlers[om[1]](b, req);
      if (!fn) return json(res, 404, { error: 'rota não encontrada' });
      // Ações exigem um cabeçalho que outro site não consegue mandar sem permissão.
      if (req.method === 'POST' && req.headers['x-estudio'] !== '1') return json(res, 403, { error: 'proibido' });
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const out = await fn(body);
        if (om && om[1] === 'logout') return json(res, 200, out, { 'set-cookie': 'estudio_sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
        json(res, 200, out);
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }
    serveStatic(req, res);
  });

  setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, 25000);

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log(ONLINE ? `  Estúdio de Agentes online na porta ${PORT}` : '  Estúdio de Agentes rodando em ' + URL_BASE);
    if (!ONLINE) console.log('  Deixe esta janela aberta enquanto usa. Para fechar o Estúdio, feche esta janela.');
    console.log('');
    openBrowser(URL_BASE);
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `A porta ${PORT} já está em uso por outro programa.` : e.message);
    process.exit(1);
  });

  const bye = () => { if (online) online.shutdown(); core.shutdown(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
})();
