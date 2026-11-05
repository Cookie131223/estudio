// Modo online (Railway): senha com sessão, contas das IAs no servidor, projetos e terminal de login.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { cleanEnv, killTree } = require('./proc');

const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (m) => (/[HfJ]$/.test(m) ? '\n' : /C$/.test(m) ? ' ' : ''))
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

const TERM_KEYS = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', esc: '\x1b', tab: '\t', ctrlc: '\x03' };
const LOGIN_CMDS = {
  gemini: 'agy',
  codex: 'codex login --device-auth',
};

function createOnline({ store, send, core, dataDir }) {
  const S = store.data.secrets;
  S.sessions = S.sessions || {};
  const home = os.homedir();
  const projectsRoot = path.join(dataDir, 'projetos');
  fs.mkdirSync(projectsRoot, { recursive: true });

  if (S.claudeToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = S.claudeToken;

  /* ------------------------------- senha -------------------------------- */
  const scrypt = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
  function checkPassword(pw) {
    if (S.passwordHash) {
      const [salt, h] = S.passwordHash.split(':');
      const a = Buffer.from(scrypt(pw, salt), 'hex');
      const b = Buffer.from(h, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const envPw = process.env.ESTUDIO_PASSWORD || '';
    if (!envPw) return false;
    const a = Buffer.from(sha(pw)); const b = Buffer.from(sha(envPw));
    return crypto.timingSafeEqual(a, b);
  }
  const fails = new Map();
  function login(pw, ip) {
    const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return { error: 'Muitas tentativas. Espere um minuto e tente de novo.' };
    if (!checkPassword(pw)) {
      f.n++;
      if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
      fails.set(ip, f);
      return { error: 'Senha errada.' };
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    for (const [k, exp] of Object.entries(S.sessions)) if (exp < now) delete S.sessions[k];
    S.sessions[sha(token)] = now + SESSION_DAYS * 864e5;
    store.save();
    return { token };
  }
  function tokenFrom(cookieHeader) {
    const m = String(cookieHeader || '').match(/(?:^|;\s*)estudio_sess=([a-f0-9]{64})/);
    return m ? m[1] : null;
  }
  function validSession(cookieHeader) {
    const t = tokenFrom(cookieHeader);
    if (!t) return false;
    const exp = S.sessions[sha(t)];
    return !!exp && exp > Date.now();
  }
  function logout(cookieHeader) {
    const t = tokenFrom(cookieHeader);
    if (t) { delete S.sessions[sha(t)]; store.save(); }
    return { ok: true };
  }
  function setPassword({ current, next }) {
    if (!checkPassword(current)) return { error: 'A senha atual está errada.' };
    if (String(next || '').length < 8) return { error: 'A nova senha precisa ter pelo menos 8 caracteres.' };
    const salt = crypto.randomBytes(16).toString('hex');
    S.passwordHash = `${salt}:${scrypt(next, salt)}`;
    S.sessions = {};
    store.save();
    return { ok: true };
  }

  /* ------------------------------- contas ------------------------------- */
  function applyGit() {
    const run = (args) => spawnSync('git', args, { env: cleanEnv(), stdio: 'ignore' });
    if (S.githubToken) {
      fs.writeFileSync(path.join(home, '.git-credentials'), `https://x-access-token:${S.githubToken}@github.com\n`, { mode: 0o600 });
      run(['config', '--global', 'credential.helper', 'store']);
    }
    run(['config', '--global', 'user.name', S.githubUser || 'Estúdio de Agentes']);
    run(['config', '--global', 'user.email', S.githubEmail || `${S.githubUser || 'estudio'}@users.noreply.github.com`]);
    run(['config', '--global', 'init.defaultBranch', 'main']);
  }
  applyGit();

  const codexAuth = () => path.join(home, '.codex', 'auth.json');
  function accounts() {
    let codex = false;
    try { codex = fs.statSync(codexAuth()).size > 10; } catch {}
    return { claude: !!S.claudeToken, codex, github: !!S.githubToken, githubUser: S.githubUser || '' };
  }

  async function setAccount({ key, value }) {
    const v = typeof value === 'string' ? value.trim() : value;
    if (key === 'claude') {
      if (!v) { delete S.claudeToken; delete process.env.CLAUDE_CODE_OAUTH_TOKEN; store.save(); return { ok: true }; }
      if (!/^sk-ant-oat/.test(v)) return { error: 'Esse não parece o token do "claude setup-token" (ele começa com sk-ant-oat).' };
      S.claudeToken = v; process.env.CLAUDE_CODE_OAUTH_TOKEN = v; store.save();
      return { ok: true };
    }
    if (key === 'codex') {
      if (!v) { try { fs.rmSync(codexAuth(), { force: true }); } catch {} return { ok: true }; }
      let j;
      try { j = JSON.parse(v); } catch { return { error: 'O arquivo não é um auth.json válido.' }; }
      if (!j.tokens) return { error: 'Esse auth.json não tem o login do ChatGPT (só chave de API, que é cobrada por uso).' };
      fs.mkdirSync(path.dirname(codexAuth()), { recursive: true });
      fs.writeFileSync(codexAuth(), JSON.stringify(j), { mode: 0o600 });
      return { ok: true };
    }
    if (key === 'github') {
      if (!v) { delete S.githubToken; delete S.githubUser; try { fs.rmSync(path.join(home, '.git-credentials'), { force: true }); } catch {} store.save(); return { ok: true }; }
      let user;
      try {
        const r = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${v}`, 'user-agent': 'estudio-agentes' } });
        if (!r.ok) return { error: r.status === 401 ? 'Token do GitHub inválido.' : `GitHub respondeu ${r.status}.` };
        user = await r.json();
      } catch (e) { return { error: `Não consegui falar com o GitHub: ${e.message}` }; }
      S.githubToken = v; S.githubUser = user.login; S.githubEmail = `${user.id}+${user.login}@users.noreply.github.com`;
      store.save();
      applyGit();
      return { ok: true, user: user.login };
    }
    return { error: 'Conta desconhecida.' };
  }

  /* --------------------------- terminal de login ------------------------- */
  let term = null;
  function termStart({ key }) {
    const cmd = LOGIN_CMDS[key];
    if (!cmd) return { error: 'Login não disponível para essa conta.' };
    if (term) { try { killTree(term.child); } catch {} term = null; }
    const child = spawn('script', ['-qfec', `stty cols 300 rows 45 2>/dev/null; ${cmd}`, '/dev/null'], {
      cwd: home, env: { ...cleanEnv(), TERM: 'xterm-256color' }, detached: true,
    });
    term = { key, child };
    const onData = (c) => {
      const t = stripAnsi(c.toString('utf8'));
      if (t.trim()) send({ kind: 'loginTerm', key, text: t });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => send({ kind: 'loginTerm', key, text: `\nErro: ${e.message}\n` }));
    child.on('close', (code) => {
      if (term && term.child === child) term = null;
      send({ kind: 'loginTerm', key, done: true, code });
      core.detectProviders();
    });
    return { ok: true };
  }
  function termInput({ text, keyName }) {
    if (!term) return { error: 'O terminal não está aberto.' };
    term.child.stdin.write(keyName ? (TERM_KEYS[keyName] || '') : `${String(text || '')}\r`);
    return { ok: true };
  }
  function termStop() {
    if (term) { try { killTree(term.child); } catch {} term = null; }
    return { ok: true };
  }

  /* ------------------------------ projetos ------------------------------ */
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  function projects() {
    const cur = store.settings.projectDir;
    const list = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const p = path.join(projectsRoot, d.name);
      return { name: d.name, path: p, git: fs.existsSync(path.join(p, '.git')), current: p === cur };
    });
    return { root: projectsRoot, list, current: cur };
  }
  function newProject({ name }) {
    const n = slug(name);
    if (!n) return { error: 'Dê um nome ao projeto.' };
    const p = path.join(projectsRoot, n);
    fs.mkdirSync(p, { recursive: true });
    return { path: core.setProjectDir(p) };
  }
  function cloneProject({ url }) {
    let u = String(url || '').trim().replace(/\.git$/, '');
    const m = u.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)\/?$/i);
    if (!m) return Promise.resolve({ error: 'Use o endereço do GitHub (https://github.com/dono/repo) ou dono/repo.' });
    const repoUrl = `https://github.com/${m[1]}/${m[2]}.git`;
    const dest = path.join(projectsRoot, slug(m[2]));
    if (fs.existsSync(path.join(dest, '.git'))) return Promise.resolve({ path: core.setProjectDir(dest), existed: true });
    return new Promise((resolve) => {
      let err = '';
      const child = spawn('git', ['clone', repoUrl, dest], { env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0' } });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => killTree(child), 5 * 60000);
      child.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) {
          const msg = /not found|Authentication|could not read/i.test(err)
            ? 'Não achei o repositório ou não tenho acesso. Se ele for privado, conecte o GitHub em Ajustes → Contas.'
            : err.split('\n').filter(Boolean).slice(-2).join(' ');
          return resolve({ error: msg });
        }
        resolve({ path: core.setProjectDir(dest) });
      });
    });
  }

  const handlers = {
    logout: (b, req) => logout(req.headers.cookie),
    password: setPassword,
    accounts: () => accounts(),
    account: setAccount,
    termStart, termInput, termStop,
    projects: () => projects(),
    projectNew: newProject,
    projectClone: cloneProject,
  };

  return { login, validSession, handlers, accounts, shutdown: termStop };
}

module.exports = { createOnline, stripAnsi };
