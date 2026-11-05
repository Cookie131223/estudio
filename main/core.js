// Núcleo compartilhado entre o modo navegador (server.js) e o modo janela (Electron, main.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const { Store } = require('./store');
const { Approvals } = require('./approvals');
const { Orchestrator } = require('./orchestrator');
const { createCopilot } = require('./copilot');
const { PROVIDERS } = require('./providers');
const { capture, IS_WIN } = require('./proc');

async function createCore({ dataDir, send }) {
  const store = new Store(dataDir);
  const providerInfo = {};
  let orch;
  const approvals = new Approvals({
    getContext: (taskId) => orch.contextFor(taskId),
    onRequest: (req) => {
      orch.noteApproval(req.taskId);
      send({ kind: 'approval', ...req });
      send({ kind: 'agentState', agentId: req.agentId, state: 'waiting', detail: 'Preciso da sua aprovação' });
    },
    onResolved: (r) => {
      send({ kind: 'approvalResolved', ...r });
      if (orch.busy) send({ kind: 'agentState', agentId: r.agentId, state: 'working', detail: r.decision === 'allow' ? 'Aprovado' : 'Negado' });
    },
    onAuto: (r) => send({ kind: 'activity', agentId: r.agentId, taskId: r.taskId, type: 'auto', text: `Liberado automaticamente: ${r.summary}` }),
  });
  await approvals.start();
  orch = new Orchestrator({
    store, approvals, emit: send,
    mcp: { nodePath: process.execPath, scriptPath: path.join(__dirname, 'approval-mcp.js') },
  });

  function snapshot() {
    const since = Date.now() - 31 * 864e5;
    return {
      settings: store.settings,
      agents: store.agents,
      messages: store.data.messages.slice(-120),
      tasks: store.data.tasks.filter((t) => t.start >= since),
      requests: store.data.requests.filter((r) => r.at >= since),
      limits: store.data.limits,
      busy: orch.busy,
      providers: providerInfo,
      pending: [...approvals.pending.values()].map((p) => p.req),
      platform: process.platform,
    };
  }

  async function detectProviders() {
    await Promise.all(Object.entries(PROVIDERS).map(async ([key, p]) => {
      const r = await capture(p.bin ? p.bin() : p.cli, p.versionArgs, { timeoutMs: 20000 });
      const ver = (r.out || '').split('\n').find((l) => /\d+\.\d+/.test(l)) || '';
      providerInfo[key] = { ...(providerInfo[key] || {}), installed: r.code === 0, version: ver.trim().slice(0, 60), checkedAt: Date.now() };
    }));
    send({ kind: 'providers', providers: providerInfo });
    return providerInfo;
  }

  async function testProvider(key) {
    const tests = {
      claude: ['claude', ['-p', '--output-format', 'text']],
      codex: ['codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']],
      gemini: [PROVIDERS.gemini.bin(), ['-p', 'Responda apenas com a palavra OK.']],
    };
    if (!tests[key]) return null;
    const [cmd, args] = tests[key];
    const r = await capture(cmd, args, { timeoutMs: 120000, stdin: key === 'gemini' ? null : 'Responda apenas com a palavra OK.', cwd: os.homedir() });
    const ok = r.code === 0 && /ok/i.test(r.out);
    const msg = ok ? 'Login funcionando.' : (r.err || r.out || 'Sem resposta.').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
    providerInfo[key] = { ...(providerInfo[key] || {}), loginOk: ok, loginMsg: msg, testedAt: Date.now() };
    send({ kind: 'providers', providers: providerInfo });
    return providerInfo[key];
  }

  /** Abre um terminal para fazer login. Se o CLI não estiver instalado, instala antes (npm install -g). */
  function openLogin(key) {
    const p = PROVIDERS[key];
    if (!p) return false;
    const installed = providerInfo[key] && providerInfo[key].installed;
    const title = installed ? `Login ${key}` : `Instalando ${key}`;
    if (p.installer === 'antigravity') {
      // Antigravity CLI: instalador oficial da Google e depois "agy" para o login com a conta Google.
      if (IS_WIN) {
        // Um .ps1 próprio evita problemas de aspas e pipes no cmd; -NoExit deixa a janela aberta para ver erros.
        const script = path.join(dataDir, 'instalar-antigravity.ps1');
        const body = [
          "$agy = Join-Path $env:LOCALAPPDATA 'agy\\bin\\agy.exe'",
          installed ? '' : "Write-Host 'Instalando o Antigravity CLI (Gemini)...' -ForegroundColor Cyan",
          installed ? '' : "try { irm https://antigravity.google/cli/install.ps1 | iex } catch { Write-Host $_ -ForegroundColor Red }",
          "if (Test-Path $agy) { Write-Host ''; Write-Host 'Agora faca o login: abra o link, entre com sua conta Google e cole o codigo aqui.' -ForegroundColor Cyan; & $agy }",
          "else { Write-Host 'Nao encontrei o agy.exe. Veja a mensagem acima e mande um print para o Claude.' -ForegroundColor Yellow }",
        ].filter(Boolean).join('\r\n');
        fs.writeFileSync(script, '\ufeff' + body, 'utf8');
        const child = spawn('cmd.exe', ['/c', `start "Antigravity" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${script}"`], { detached: true, windowsHide: true, windowsVerbatimArguments: true });
        child.on('error', (e) => send({ kind: 'notice', text: `Não consegui abrir o PowerShell: ${e.message}` }));
        child.unref();
      } else {
        const sh = installed ? 'agy' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash && ~/.local/bin/agy';
        if (process.platform === 'darwin') exec(`osascript -e 'tell application "Terminal" to do script "${sh}"'`);
        else exec(`x-terminal-emulator -e sh -c '${sh}; exec sh'`);
      }
      return { installing: !installed, manual: 'irm https://antigravity.google/cli/install.ps1 | iex' };
    }
    const cmd = installed ? p.loginCmd : `npm install -g ${p.pkg} && ${p.loginCmd}`;
    if (IS_WIN) exec(`start "${title}" cmd /k "echo ${title}... && ${cmd}"`);
    else if (process.platform === 'darwin') exec(`osascript -e 'tell application "Terminal" to do script "${cmd}"'`);
    else exec(`x-terminal-emulator -e sh -c '${cmd}; exec sh' || gnome-terminal -- sh -c '${cmd}; exec sh'`);
    return { installing: !installed };
  }

  function openFolder() {
    const dir = orch.projectDir();
    if (IS_WIN) spawn('explorer', [dir], { detached: true, windowsHide: false }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true }).unref();
    return true;
  }

  function setProjectDir(dir) {
    const full = path.resolve(String(dir || '').trim().replace(/^"|"$/g, ''));
    try {
      if (!fs.statSync(full).isDirectory()) return null;
    } catch { return null; }
    store.setSettings({ projectDir: full });
    return full;
  }

  /** Janela nativa de "escolher pasta" (Windows). Em outros sistemas devolve null e a interface pede o caminho. */
  function pickFolderNative() {
    if (!IS_WIN) return Promise.resolve({ manual: true });
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
      '$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false};',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      "$d.Description = 'Pasta do projeto onde o time vai trabalhar';",
      '$d.ShowNewFolderButton = $true;',
      "if ($d.ShowDialog($f) -eq 'OK') { Write-Output $d.SelectedPath }",
    ].join(' ');
    return new Promise((resolve) => {
      let out = '';
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
      child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.on('error', () => resolve({ manual: true }));
      child.on('close', () => {
        const dir = out.trim().split(/\r?\n/).pop();
        if (!dir) return resolve({ path: null });
        resolve({ path: setProjectDir(dir) });
      });
    });
  }

  /* ------------------------------- voz -------------------------------- */
  const ELEVEN = 'https://api.elevenlabs.io/v1';
  async function eleven(pathname, { method = 'GET', body, key, audio } = {}) {
    const k = key || store.data.secrets.elevenKey;
    if (!k) throw Object.assign(new Error('Sem chave da ElevenLabs.'), { status: 0 });
    const headers = { 'xi-api-key': k };
    if (body) headers['content-type'] = 'application/json';
    if (audio) headers.accept = 'audio/mpeg';
    const r = await fetch(ELEVEN + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      let msg = `ElevenLabs respondeu ${r.status}`;
      let detail = '';
      try { const j = await r.json(); detail = JSON.stringify(j.detail || j); const d = j.detail || {}; msg = d.message || (typeof d === 'string' ? d : msg); } catch {}
      if (/quota|credit|character_limit/i.test(detail)) msg = 'os créditos do mês acabaram';
      throw Object.assign(new Error(msg), { status: r.status, detail });
    }
    return audio ? Buffer.from(await r.arrayBuffer()) : r.json();
  }

  async function voice(op, p = {}) {
    const key = store.data.secrets.elevenKey;
    const masked = key ? '…' + key.slice(-4) : '';
    if (op === 'info') {
      if (!key) return { connected: false };
      const out = { connected: true, masked };
      try {
        const sub = await eleven('/user/subscription');
        out.sub = { used: sub.character_count, limit: sub.character_limit, resetAt: sub.next_character_count_reset_unix, tier: sub.tier };
      } catch (e) { out.subError = e.message; }
      try {
        const v = await eleven('/voices');
        out.voices = (v.voices || []).map((x) => ({ id: x.voice_id, name: x.name, labels: x.labels || {}, category: x.category }));
      } catch (e) { out.error = e.message; out.voices = []; }
      return out;
    }
    if (op === 'setKey') {
      const k = String(p.key || '').trim();
      if (!k) return { ok: false, error: 'Cole a chave.' };
      try { await eleven('/voices', { key: k }); } catch (e) {
        if (!e.status) return { ok: false, error: `Sem conexão com a ElevenLabs (${e.message}).` };
        if (e.status === 401 && !/permission/i.test(e.detail || '')) return { ok: false, error: 'Chave inválida.' };
        if (e.status && e.status !== 401) return { ok: false, error: e.message };
      }
      store.data.secrets.elevenKey = k;
      store.save();
      return { ok: true };
    }
    if (op === 'removeKey') { delete store.data.secrets.elevenKey; store.save(); return { ok: true }; }
    if (op === 'tts') {
      try {
        const buf = await eleven(`/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=mp3_44100_64`, {
          method: 'POST', audio: true,
          body: { text: String(p.text || '').slice(0, 1500), model_id: 'eleven_flash_v2_5' },
        });
        return { mime: 'audio/mpeg', audio: buf.toString('base64') };
      } catch (e) { return { error: e.message }; }
    }
    return { error: 'operação desconhecida' };
  }

  const copilot = createCopilot({ dataDir, send, store });

  detectProviders();

  return {
    voice,
    copilot,
    store, approvals, orch, snapshot, detectProviders, testProvider, openLogin, openFolder, setProjectDir, pickFolderNative,
    shutdown() {
      try { copilot.shutdown(); } catch {}
      try { orch.stop(); } catch {}
      try { store.flush(); } catch {}
      approvals.stop();
    },
  };
}

module.exports = { createCore };
