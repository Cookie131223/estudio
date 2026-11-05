// Copiloto de tela: recebe capturas da tela (do navegador), pede ao Claude Code uma dica
// e, se o usuário liberar, executa UMA ação por vez com mouse/teclado (Windows).
// F12 devolve o controle na hora; a permissão expira sozinha em 10 minutos.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, killTree, cleanEnv, IS_WIN } = require('./proc');
const { extractJson } = require('./orchestrator');

const CONTROL_MS = 10 * 60 * 1000;
const MODELS = { rapido: 'haiku', equilibrio: 'sonnet', esperto: 'opus' };

/* ---------------------------- mouse e teclado ---------------------------- */
const HELPER_PS1 = String.raw`Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class EstudioInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  public static volatile bool Stopped = false;
  public static void Click(int x, int y, bool right, bool dbl) {
    SetCursorPos(x, y); Thread.Sleep(60);
    uint d = right ? 0x0008u : 0x0002u; uint u = right ? 0x0010u : 0x0004u;
    int n = dbl ? 2 : 1;
    for (int i = 0; i < n; i++) { mouse_event(d, 0, 0, 0, UIntPtr.Zero); mouse_event(u, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(70); }
  }
  public static void Scroll(int notches) { mouse_event(0x0800, 0, 0, notches * 120, UIntPtr.Zero); }
  public static void Watch() {
    var t = new Thread(() => {
      while (true) {
        if ((GetAsyncKeyState(0x7B) & 0x8000) != 0) { Stopped = true; Console.Out.WriteLine("F12"); Console.Out.Flush(); Thread.Sleep(900); }
        Thread.Sleep(40);
      }
    });
    t.IsBackground = true; t.Start();
  }
}
'@
[EstudioInput]::SetProcessDPIAware() | Out-Null
[EstudioInput]::Watch()
[Console]::Out.WriteLine("READY"); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $c = $line | ConvertFrom-Json
    if ($c.op -eq 'reset') { [EstudioInput]::Stopped = $false; [Console]::Out.WriteLine("OK"); [Console]::Out.Flush(); continue }
    if ([EstudioInput]::Stopped) { [Console]::Out.WriteLine("BLOCKED"); [Console]::Out.Flush(); continue }
    switch ($c.op) {
      'click'  { [EstudioInput]::Click([int]$c.x, [int]$c.y, [bool]$c.right, [bool]$c.double) }
      'keys'   { [System.Windows.Forms.SendKeys]::SendWait([string]$c.keys) }
      'scroll' { [EstudioInput]::Scroll([int]$c.amount) }
    }
    [Console]::Out.WriteLine("OK"); [Console]::Out.Flush()
  } catch { [Console]::Out.WriteLine("ERR " + $_.Exception.Message); [Console]::Out.Flush() }
}
`;

/** Texto comum → formato do SendKeys (escapa os caracteres especiais). */
function textToSendKeys(text) {
  return String(text || '').split('').map((c) => {
    if (c === '\n') return '{ENTER}';
    if ('+^%~(){}[]'.includes(c)) return `{${c}}`;
    return c;
  }).join('');
}

const KEY_NAMES = {
  enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}', delete: '{DEL}', del: '{DEL}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', cima: '{UP}', baixo: '{DOWN}', esquerda: '{LEFT}', direita: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', espaco: ' ', espaço: ' ',
};
function keyToSendKeys(spec) {
  const parts = String(spec || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  let mods = '';
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods += '^';
    else if (p === 'alt') mods += '%';
    else if (p === 'shift') mods += '+';
    else key = p;
  }
  if (/^f([1-9]|1[01])$/.test(key)) key = `{${key.toUpperCase()}}`; // F12 fica reservado para devolver o controle
  else if (KEY_NAMES[key] != null) key = KEY_NAMES[key];
  else if (key.length === 1) key = textToSendKeys(key);
  else return null;
  return mods + key;
}

function createCopilot({ dataDir, send, store }) {
  const dir = path.join(dataDir, 'copiloto');
  fs.mkdirSync(dir, { recursive: true });
  let controlUntil = 0;
  let expiryTimer = null;
  let helper = null;
  let helperReady = null;
  const waiters = [];
  let imageMode = store.settings.copilotImageMode || 'stream'; // 'stream' (imagem direto) ou 'file' (Read)

  function revoke(reason) {
    const was = controlUntil > Date.now();
    controlUntil = 0;
    clearTimeout(expiryTimer);
    if (was) send({ kind: 'copilot', control: false, reason });
  }

  function startHelper() {
    if (!IS_WIN) return Promise.reject(new Error('O controle de mouse e teclado só funciona no Windows.'));
    if (helper && helper.exitCode == null) return helperReady;
    const file = path.join(dir, 'controle.ps1');
    fs.writeFileSync(file, '﻿' + HELPER_PS1, 'utf8');
    helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    helperReady = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('O PowerShell não respondeu.')), 15000);
      helper.stdout.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line === 'READY') { clearTimeout(t); resolve(); }
          else if (line === 'F12') revoke('F12');
          else if (line && waiters.length) waiters.shift()(line);
        }
      });
      helper.on('error', (e) => { clearTimeout(t); reject(e); });
      helper.on('exit', () => { helper = null; revoke('fechou'); while (waiters.length) waiters.shift()('ERR o controle fechou'); });
    });
    return helperReady;
  }

  async function helperCmd(obj) {
    await startHelper();
    return new Promise((resolve) => {
      waiters.push(resolve);
      helper.stdin.write(JSON.stringify(obj) + '\n');
    });
  }

  async function setControl(on) {
    if (!on) { revoke('usuário'); return { on: false }; }
    try {
      await startHelper();
      await helperCmd({ op: 'reset' });
    } catch (e) { return { on: false, error: e.message }; }
    controlUntil = Date.now() + CONTROL_MS;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => revoke('tempo'), CONTROL_MS);
    return { on: true, until: controlUntil };
  }

  /** a = ação já em pixels reais da tela: {tipo, x, y, botao, duplo, texto, tecla, quanto} */
  async function act(a) {
    if (!(controlUntil > Date.now())) return { ok: false, error: 'O controle não está liberado.' };
    let cmd;
    if (a.tipo === 'clicar') cmd = { op: 'click', x: Math.round(a.x), y: Math.round(a.y), right: a.botao === 'direito', double: !!a.duplo };
    else if (a.tipo === 'digitar') {
      const txt = String(a.texto || '');
      if (!txt || txt.length > 500) return { ok: false, error: 'Texto vazio ou longo demais.' };
      cmd = { op: 'keys', keys: textToSendKeys(txt) };
    } else if (a.tipo === 'tecla') {
      const k = keyToSendKeys(a.tecla);
      if (!k) return { ok: false, error: `Tecla desconhecida: ${a.tecla}` };
      cmd = { op: 'keys', keys: k };
    } else if (a.tipo === 'rolar') cmd = { op: 'scroll', amount: Math.max(-10, Math.min(10, Math.round(Number(a.quanto) || 0))) };
    else return { ok: false, error: 'Ação desconhecida.' };
    const r = await helperCmd(cmd);
    if (r === 'OK') return { ok: true };
    if (r === 'BLOCKED') { revoke('F12'); return { ok: false, error: 'Você apertou F12: o controle foi devolvido.' }; }
    return { ok: false, error: r.replace(/^ERR\s*/, '') };
  }

  /* ------------------------------- dicas -------------------------------- */
  function prompt({ objective, question, history, control, width, height, file }) {
    const hist = (history || []).slice(-5).map((h) => `- ${h}`).join('\n');
    return [
      file ? `Use a ferramenta Read para abrir a imagem ${file}: é uma captura da tela do usuário agora.` : 'A imagem é uma captura da tela do usuário agora.',
      'Você é o Copiloto de tela do Estúdio. Ajude o usuário a chegar no objetivo dele, como alguém olhando por cima do ombro.',
      `Objetivo do usuário: "${String(objective || 'me ajudar no que eu estiver fazendo').slice(0, 400)}"`,
      question ? `O usuário perguntou agora: "${String(question).slice(0, 400)}" (responda isso na dica).` : '',
      hist ? `Dicas que você já deu (não repita):\n${hist}` : '',
      '',
      'Responda SOMENTE com JSON, sem nada antes ou depois:',
      '{"dica":"o que fazer agora (no máximo 2 frases curtas, em português do Brasil)","nova":true,"acao":null}',
      '- Se nada importante mudou e não houve pergunta, use "nova": false e "dica": "".',
      control ? [
        '',
        'O usuário liberou você para usar o mouse e o teclado. Você pode fazer UMA ação por vez, só se ela claramente avançar o objetivo:',
        `"acao": {"tipo":"clicar","x":0,"y":0,"botao":"esquerdo","duplo":false} | {"tipo":"digitar","texto":"..."} | {"tipo":"tecla","tecla":"enter"} | {"tipo":"rolar","quanto":-3}`,
        `A imagem tem ${width}x${height} pixels; x e y são nessa escala, no centro do elemento.`,
        'Teclas aceitas: enter, tab, esc, backspace, delete, setas, ctrl+letra, alt+letra, shift+letra.',
        'NUNCA digite senhas, números de cartão ou documentos, e NUNCA confirme compras, pagamentos, exclusões, envio de mensagens ou e-mails. Nesses casos, use "acao": null e peça na dica para o usuário fazer.',
        'Se não tiver certeza de onde clicar, não clique: explique na dica.',
      ].join('\n') : '',
    ].filter((l) => l !== '').join('\n');
  }

  function runClaude(args, stdin) {
    return new Promise((resolve) => {
      let result = '';
      let usage = null;
      let isError = false;
      const h = run('claude', args, {
        cwd: dir, stdin,
        onLine(line) {
          let ev;
          try { ev = JSON.parse(line); } catch { return; }
          if (ev.type === 'result') { result = ev.result || ''; usage = ev.usage || null; isError = !!ev.is_error; }
          else if (ev.type === 'assistant' && ev.message && !result) {
            const t = (ev.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
            if (t) result = t;
          }
        },
      });
      const timer = setTimeout(() => killTree(h.child), 90000);
      h.done.then((r) => { clearTimeout(timer); resolve({ code: r.code, stderr: r.stderr, result, usage, isError }); });
    });
  }

  async function tip({ image, objective, question, history, control, model, width, height }) {
    const b64 = String(image || '').replace(/^data:image\/\w+;base64,/, '');
    if (!b64) return { error: 'Sem imagem.' };
    const ctrl = !!control && controlUntil > Date.now();
    const m = MODELS[model] || 'sonnet';
    const start = Date.now();
    const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', m];
    let r;
    if (imageMode === 'stream') {
      const msg = { type: 'user', message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: prompt({ objective, question, history, control: ctrl, width, height }) },
      ] } };
      r = await runClaude([...base, '--input-format', 'stream-json', '--disallowedTools', 'Bash,Write,Edit,MultiEdit,NotebookEdit,WebSearch,WebFetch,Task,Read,Glob,Grep,LS'], JSON.stringify(msg) + '\n');
      if (!r.result || (r.code !== 0 && !r.result)) {
        imageMode = 'file'; // versão do Claude Code sem imagem na entrada: usa o arquivo
        store.setSettings({ copilotImageMode: 'file' });
      }
    }
    if (imageMode === 'file') {
      const file = path.join(dir, 'tela.jpg');
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      r = await runClaude([...base, '--disallowedTools', 'Bash,Write,Edit,MultiEdit,NotebookEdit,WebSearch,WebFetch,Task,Glob,Grep,LS'], prompt({ objective, question, history, control: ctrl, width, height, file: 'tela.jpg' }));
    }
    const u = r.usage || {};
    store.addTask({
      id: Math.random().toString(16).slice(2), agentId: 'copiloto', provider: 'claude', model: m, label: 'copiloto',
      start, end: Date.now(), ok: !!r.result, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, costUsd: 0, files: 0, approvals: 0, tools: 0,
    });
    if (!r.result) {
      const err = String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ');
      return { error: /reconhecido|not recognized|ENOENT/i.test(err) ? 'Claude Code não está instalado.' : (err || 'O Claude não respondeu.').slice(0, 240) };
    }
    const j = extractJson(r.result) || { dica: r.result.slice(0, 300), nova: true, acao: null };
    let acao = ctrl && j.acao && typeof j.acao === 'object' ? j.acao : null;
    if (acao && acao.tipo === 'clicar' && !(Number.isFinite(+acao.x) && Number.isFinite(+acao.y))) acao = null;
    return { dica: String(j.dica || '').trim(), nova: j.nova !== false, acao, ms: Date.now() - start, model: m };
  }

  function status() { return { control: controlUntil > Date.now(), until: controlUntil, windows: IS_WIN }; }

  return { tip, setControl, act, status, shutdown() { revoke('fechou'); if (helper) try { helper.kill(); } catch {} } };
}

module.exports = { createCopilot, textToSendKeys, keyToSendKeys };
