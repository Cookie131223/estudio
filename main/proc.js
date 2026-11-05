// Utilitários para rodar os CLIs oficiais (claude, codex, gemini) como processos filhos.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// No Windows os CLIs instalados via npm são .cmd e precisam de shell:true.
// Aí os argumentos passam pelo cmd.exe, então colocamos aspas em tudo que tem espaço.
function quoteWin(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// Variáveis que fariam os CLIs usarem API paga em vez da assinatura.
const API_KEY_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of API_KEY_VARS) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return { ...env, ...extra };
}

/**
 * Roda um comando e entrega a saída linha a linha.
 * Retorna { child, done } — done resolve com { code, stderr }.
 */
// Registro do que cada CLI devolveu (pasta logs/ do app), para diagnosticar formatos novos.
function openLog(cmd, args) {
  const dir = process.env.ESTUDIO_LOG_DIR;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.rmSync(path.join(dir, f), { force: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(String(cmd)).replace(/\.exe$/i, '')}.log`;
    const file = path.join(dir, name);
    const shown = args.map((a) => (String(a).length > 300 ? `<${String(a).length} caracteres>` : a));
    fs.writeFileSync(file, `CMD ${cmd} ${JSON.stringify(shown)}\n`);
    return (tag, line) => { try { fs.appendFileSync(file, `${tag} ${line}\n`); } catch {} };
  } catch { return null; }
}

function run(cmd, args, { cwd, stdin, env, onLine, onErrLine } = {}) {
  const log = openLog(cmd, args);
  const opts = {
    cwd,
    env: env || cleanEnv(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  let child;
  const directExe = IS_WIN && /^[a-z]:\\.*\.exe$/i.test(cmd);
  if (directExe) {
    child = spawn(cmd, args, opts);
  } else if (IS_WIN) {
    child = spawn(quoteWin(cmd), args.map(quoteWin), { ...opts, shell: true });
  } else {
    child = spawn(cmd, args, { ...opts, detached: true });
  }

  let stderr = '';
  const splitter = (cb) => {
    let buf = '';
    return {
      push(chunk) {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim() && cb) cb(line);
        }
      },
      flush() { if (buf.trim() && cb) cb(buf.replace(/\r$/, '')); buf = ''; },
    };
  };
  const out = splitter((l) => { if (log) log('OUT', l); if (onLine) onLine(l); });
  const err = splitter((l) => { stderr += l + '\n'; if (log) log('ERR', l); if (onErrLine) onErrLine(l); });
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));

  const done = new Promise((resolve) => {
    child.on('error', (e) => { stderr += String(e && e.message) + '\n'; });
    child.on('close', (code) => { out.flush(); err.flush(); if (log) log('EXIT', code); resolve({ code: code == null ? -1 : code, stderr }); });
  });

  if (stdin != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdin, 'utf8');
  } else {
    child.stdin.end();
  }
  return { child, done };
}

function killTree(child) {
  if (!child || child.exitCode != null || child.killed) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
    }
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/** Roda e junta toda a saída (para --version, testes rápidos). */
async function capture(cmd, args, { timeoutMs = 20000, cwd, stdin } = {}) {
  let out = '';
  const h = run(cmd, args, { cwd, stdin, onLine: (l) => { out += l + '\n'; } });
  const t = setTimeout(() => killTree(h.child), timeoutMs);
  const r = await h.done;
  clearTimeout(t);
  return { code: r.code, out: out.trim(), err: r.stderr.trim() };
}

module.exports = { run, capture, killTree, cleanEnv, quoteWin, IS_WIN };
