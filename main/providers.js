// Adaptadores dos três CLIs oficiais. Cada um transforma a saída do CLI em eventos comuns:
//   { type:'session', id, model }
//   { type:'text', text }              trecho de resposta do agente
//   { type:'tool', name, detail }      o agente está usando uma ferramenta
//   { type:'tool_result', ok, detail }
//   { type:'usage', input, output, cached, costUsd }
//   { type:'limits', data }            limites da assinatura, quando o CLI informa
//   { type:'error', text }
// e devolve { final, ok } no fim.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { run, killTree, IS_WIN } = require('./proc');

const short = (s, n = 140) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');

function describeTool(name, input = {}) {
  const n = String(name || '');
  const i = input || {};
  const file = i.file_path || i.path || i.notebook_path || i.absolute_path || i.TargetFile || i.AbsolutePath || i.target_file || '';
  const cmd = i.command || i.CommandLine || i.command_line || '';
  switch (n) {
    case 'run_command': return `Rodando: ${short(cmd, 90)}`;
    case 'write_to_file': return `Criando ${base(file)}`;
    case 'replace_file_content': case 'multi_replace_file_content': case 'sed_file': return `Editando ${base(file)}`;
    case 'view_file': return `Lendo ${base(file)}`;
    case 'list_dir': return `Olhando a pasta ${base(file || i.DirectoryPath) || '.'}`;
    case 'grep_search': return `Buscando no código "${short(i.Query || i.query || i.pattern, 50)}"`;
    case 'find_by_name': return `Procurando arquivos ${short(i.Pattern || i.pattern, 60)}`;
    case 'search_web': return `Pesquisando na web: ${short(i.query || i.Query, 80)}`;
    case 'read_url_content': case 'open_browser_url': return `Abrindo ${short(i.Url || i.url, 80)}`;
    case 'generate_image': return 'Gerando uma imagem';
    case 'Read': case 'read_file': case 'read_many_files': return `Lendo ${base(file) || short(JSON.stringify(i.paths || ''), 60)}`;
    case 'Write': case 'write_file': return `Criando ${base(file)}`;
    case 'Edit': case 'MultiEdit': case 'replace': case 'NotebookEdit': return `Editando ${base(file)}`;
    case 'Bash': case 'run_shell_command': return `Rodando: ${short(i.command, 90)}`;
    case 'Glob': case 'glob': return `Procurando arquivos ${short(i.pattern, 60)}`;
    case 'Grep': case 'search_file_content': return `Buscando no código "${short(i.pattern, 50)}"`;
    case 'LS': case 'list_directory': return `Olhando a pasta ${base(file) || '.'}`;
    case 'WebSearch': case 'google_web_search': return `Pesquisando na web: ${short(i.query, 80)}`;
    case 'WebFetch': case 'web_fetch': return `Abrindo ${short(i.url || i.prompt, 80)}`;
    case 'TodoWrite': case 'write_todos': return 'Atualizando a lista de tarefas';
    case 'Task': return `Delegando: ${short(i.description, 70)}`;
    default: return n.replace(/^mcp__/, '');
  }
}

// Ferramentas do Claude Code agrupadas pelas permissões do agente.
const CLAUDE_TOOL_GROUPS = {
  write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  bash: ['Bash', 'BashOutput', 'KillShell'],
  web: ['WebSearch', 'WebFetch'],
};

function findRateLimits(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const k of Object.keys(obj)) {
    if (/rate_?limit/i.test(k) && obj[k] && typeof obj[k] === 'object') return obj[k];
    const r = findRateLimits(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/* ------------------------------ Claude Code ------------------------------ */
function runClaude({ prompt, cwd, model, readOnly, tools = {}, mcpConfigPath, emit }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'];
  if (model) args.push('--model', model);
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath, '--permission-prompt-tool', 'mcp__estudio__approve');
  }
  const blocked = [];
  for (const [group, list] of Object.entries(CLAUDE_TOOL_GROUPS)) {
    if (readOnly && group !== 'web') blocked.push(...list);
    else if (tools[group] === false) blocked.push(...list);
  }
  if (blocked.length) args.push('--disallowedTools', blocked.join(','));

  let final = '';
  let lastText = '';
  let ok = true;
  const h = run('claude', args, {
    cwd, stdin: prompt,
    onLine(line) {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const lim = findRateLimits(ev);
      if (lim) emit({ type: 'limits', data: lim });
      if (ev.type === 'system' && ev.subtype === 'init') {
        emit({ type: 'session', id: ev.session_id, model: ev.model });
      } else if (ev.type === 'assistant' && ev.message) {
        for (const c of ev.message.content || []) {
          if (c.type === 'text' && c.text) { lastText = c.text; emit({ type: 'text', text: c.text }); }
          else if (c.type === 'tool_use') emit({ type: 'tool', name: c.name, detail: describeTool(c.name, c.input), input: c.input });
        }
      } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const c of ev.message.content) {
          if (c.type === 'tool_result') {
            const txt = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content;
            emit({ type: 'tool_result', ok: !c.is_error, detail: short(txt, 120) });
          }
        }
      } else if (ev.type === 'result') {
        final = ev.result || lastText;
        ok = !ev.is_error && (ev.subtype ? ev.subtype === 'success' : true);
        const u = ev.usage || {};
        emit({
          type: 'usage',
          input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          cached: u.cache_read_input_tokens || 0,
          output: u.output_tokens || 0,
          costUsd: ev.total_cost_usd || 0,
        });
        if (!ok) emit({ type: 'error', text: short(ev.result || ev.subtype, 200) });
      }
    },
  });
  const done = h.done.then((r) => {
    if (!final) final = lastText;
    if (r.code !== 0 && !final) {
      ok = false;
      emit({ type: 'error', text: explainFailure('Claude Code', r.stderr) });
    }
    return { ok: ok && (r.code === 0 || !!final), final };
  });
  return { child: h.child, done };
}

/* ------------------------------- Codex CLI ------------------------------- */
function runCodex({ prompt, cwd, model, effort, readOnly, autonomy, tools = {}, emit }) {
  let sandbox = 'workspace-write';
  if (readOnly || autonomy === 'ask' || tools.write === false) sandbox = 'read-only';
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox, '-C', cwd];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (autonomy === 'auto' && tools.web !== false && !readOnly) args.push('-c', 'sandbox_workspace_write.network_access=true');
  args.push('-');

  let final = '';
  let ok = true;
  const seen = new Set();
  const h = run('codex', args, {
    cwd, stdin: prompt,
    onLine(line) {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const lim = findRateLimits(ev);
      if (lim) emit({ type: 'limits', data: lim });

      // Formato novo: thread.started / item.* / turn.completed
      if (ev.type === 'thread.started') emit({ type: 'session', id: ev.thread_id });
      else if (ev.type && ev.type.startsWith('item.') && ev.item) {
        const it = ev.item;
        const started = ev.type === 'item.started';
        const completed = ev.type === 'item.completed';
        if (it.type === 'agent_message' && completed && it.text) { final = it.text; emit({ type: 'text', text: it.text }); }
        else if (it.type === 'reasoning' && completed && it.text) emit({ type: 'thinking', text: short(it.text, 160) });
        else if (it.type === 'command_execution') {
          if (started || (completed && !seen.has(it.id))) emit({ type: 'tool', name: 'Bash', detail: `Rodando: ${short(it.command, 90)}` });
          seen.add(it.id);
          if (completed) emit({ type: 'tool_result', ok: it.exit_code === 0 || it.status === 'completed', detail: short(it.aggregated_output, 120) });
        } else if (it.type === 'file_change' && completed) {
          for (const c of it.changes || []) emit({ type: 'tool', name: 'Edit', detail: `${c.kind === 'add' ? 'Criando' : c.kind === 'delete' ? 'Apagando' : 'Editando'} ${base(c.path)}`, file: c.path });
        } else if (it.type === 'web_search' && started) emit({ type: 'tool', name: 'WebSearch', detail: `Pesquisando na web: ${short(it.query, 80)}` });
        else if (it.type === 'mcp_tool_call' && started) emit({ type: 'tool', name: it.tool, detail: `${it.server}: ${it.tool}` });
        else if (it.type === 'todo_list' && started) emit({ type: 'tool', name: 'TodoWrite', detail: 'Montando a lista de tarefas' });
        else if (it.type === 'error' && it.message) emit({ type: 'error', text: short(it.message, 200) });
      } else if (ev.type === 'turn.completed') {
        const u = ev.usage || {};
        emit({ type: 'usage', input: u.input_tokens || 0, cached: u.cached_input_tokens || 0, output: u.output_tokens || 0, costUsd: 0 });
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        ok = false;
        emit({ type: 'error', text: short((ev.error && ev.error.message) || ev.message, 200) });
      }

      // Formato antigo: { msg: { type: ... } }
      const m = ev.msg;
      if (m && m.type) {
        if (m.type === 'agent_message' && m.message) { final = m.message; emit({ type: 'text', text: m.message }); }
        else if (m.type === 'exec_command_begin') emit({ type: 'tool', name: 'Bash', detail: `Rodando: ${short([].concat(m.command || []).join(' '), 90)}` });
        else if (m.type === 'patch_apply_begin') emit({ type: 'tool', name: 'Edit', detail: `Editando ${Object.keys(m.changes || {}).map(base).join(', ')}` });
        else if (m.type === 'token_count' && m.info && m.info.total_token_usage) {
          const u = m.info.total_token_usage;
          emit({ type: 'usage_total', input: u.input_tokens || 0, cached: u.cached_input_tokens || 0, output: u.output_tokens || 0 });
        } else if (m.type === 'task_complete' && m.last_agent_message) final = m.last_agent_message;
        else if (m.type === 'error') { ok = false; emit({ type: 'error', text: short(m.message, 200) }); }
      }
    },
  });
  const done = h.done.then((r) => {
    if (r.code !== 0 && !final) { ok = false; emit({ type: 'error', text: explainFailure('Codex', r.stderr) }); }
    return { ok: ok && !!final, final };
  });
  return { child: h.child, done };
}

/* ------------------------- Gemini · Antigravity CLI ------------------------ */
// Desde jun/2026 o Gemini CLI não atende mais contas pessoais; o substituto é o Antigravity CLI ("agy").

/** Acha o executável do agy (no Windows ele fica em %LOCALAPPDATA%\agy\bin e nem sempre está no PATH). */
function resolveAgy() {
  const cands = [];
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin', IS_WIN ? 'agy.exe' : 'agy'));
  cands.push(path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'agy.exe' : 'agy'));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  if (IS_WIN) {
    try {
      const r = spawnSync('where', ['agy'], { encoding: 'utf8', windowsHide: true });
      const exe = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
      if (exe) return exe;
    } catch {}
  }
  return 'agy';
}

const AGY_FORMATS = ['stream-json', 'json', null];

/** Último recurso: procura o texto da resposta em qualquer formato de JSON. */
function textFromAny(objs) {
  const found = [];
  const walk = (o, depth, role) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    const r = String(o.role || o.author || role || '');
    if (/user|system/i.test(r)) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^(text|content|response|result|output|answer|message|final|summary)$/i.test(k) && v.trim() && !/^(success|ok|error|completed?)$/i.test(v.trim())) found.push(v);
      else if (v && typeof v === 'object') walk(v, depth + 1, r);
    }
  };
  for (const o of objs) walk(o, 0, '');
  if (!found.length) return '';
  const longest = found.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest;
}

function runAntigravity({ prompt, cwd, model, readOnly, autonomy, tools = {}, emit }, fmtIdx = 0) {
  const fmt = AGY_FORMATS[fmtIdx];
  let mode = 'accept-edits';
  if (readOnly || autonomy === 'ask' || tools.write === false) mode = 'plan';
  else if (autonomy === 'auto') mode = 'auto';
  // O prompt vai como argumento (o agy não lê da entrada padrão no modo -p).
  const text = prompt.length > 28000 ? prompt.slice(0, 28000) + '\n[…cortado…]' : prompt;
  const args = ['-p', text, '--mode', mode];
  if (fmt) args.push('--output-format', fmt);
  if (model) args.push('--model', model);

  let deltas = '';
  let lastMsg = '';
  let resultText = '';
  const raw = [];
  let sawJson = false;
  let ok = true;
  const str = (v) => (typeof v === 'string' ? v : '');
  const usageOf = (u) => ({
    input: u.input_tokens || u.inputTokens || u.prompt_tokens || u.promptTokens || u.input || 0,
    cached: u.cached_tokens || u.cachedTokens || u.cached_input_tokens || u.cached || 0,
    output: u.output_tokens || u.outputTokens || u.completion_tokens || u.candidatesTokens || u.output || 0,
  });

  const objs = [];
  const steps = new Map(); // step_index -> { type, announced }
  const handleObj = (raw0) => {
    if (!raw0 || typeof raw0 !== 'object') return;
    sawJson = true;
    objs.push(raw0);
    const lim = findRateLimits(raw0);
    if (lim) emit({ type: 'limits', data: lim });
    // Formato do agy 1.5: { "event": "step_update", "step_update": { ... } }
    const evName = String(raw0.event || raw0.type || raw0.kind || '').toLowerCase();
    const inner = raw0.event && raw0[raw0.event] && typeof raw0[raw0.event] === 'object' ? raw0[raw0.event] : null;
    if (inner) {
      if (evName === 'init') { emit({ type: 'session', id: inner.conversation_id || raw0.conversation_id }); return; }
      if (evName === 'step_update') {
        const st = String(inner.step_type || '').toLowerCase();
        const state = String(inner.state || '').toUpperCase();
        if (st === 'user_input') return;
        const delta = str(inner.text_delta) || str(inner.delta);
        if (st === 'agent_response' || st === 'response' || st === 'assistant_message') {
          if (delta) { deltas += delta; emit({ type: 'text', text: delta, delta: true }); }
          else if (str(inner.text)) { lastMsg = inner.text; }
          return;
        }
        if (/think|reason|plan/.test(st)) {
          if (delta && state !== 'DONE') emit({ type: 'thinking', text: short(delta, 160) });
          return;
        }
        // Qualquer outro passo é uma ferramenta (rodar comando, editar arquivo, pesquisar…)
        const key = inner.step_index;
        const rec = steps.get(key) || { announced: false };
        steps.set(key, rec);
        const name = inner.tool_name || inner.tool || (inner.tool_call && inner.tool_call.name) || st;
        const input = inner.args || inner.arguments || inner.input || inner.parameters || (inner.tool_call && (inner.tool_call.args || inner.tool_call.arguments)) || {};
        if (!rec.announced) { rec.announced = true; emit({ type: 'tool', name, detail: describeTool(name, input), input }); }
        if (state === 'DONE' || state === 'ERROR' || state === 'FAILED') {
          emit({ type: 'tool_result', ok: state === 'DONE', detail: short(str(inner.output) || str(inner.error) || '', 120) });
        }
        return;
      }
      if (evName === 'result') {
        const r = str(inner.response) || str(inner.result) || str(inner.text);
        if (r) resultText = r;
        const u = inner.usage || inner.stats;
        if (u && typeof u === 'object') emit({ type: 'usage', input: u.input_tokens || 0, cached: u.cache_read_tokens || u.cached_tokens || 0, output: (u.output_tokens || 0), costUsd: 0 });
        if (inner.status && !/success|ok|complete/i.test(String(inner.status))) { ok = false; emit({ type: 'error', text: `Antigravity terminou com status ${inner.status}` }); }
        return;
      }
      if (evName === 'error') { emit({ type: 'error', text: short(str(inner.message) || str(inner.error) || 'erro', 200) }); return; }
    }
    const ev = raw0;
    const t = evName;
    if (/init|session_start|start/.test(t) && (ev.session_id || ev.sessionId || ev.model)) {
      emit({ type: 'session', id: ev.session_id || ev.sessionId, model: ev.model });
    } else if (/tool/.test(t) && /result|output|end|done|complete/.test(t)) {
      const st = String(ev.status || '').toLowerCase();
      emit({ type: 'tool_result', ok: !/error|fail/.test(st) && !ev.is_error, detail: short(str(ev.output) || str(ev.result) || str(ev.error && ev.error.message), 120) });
    } else if (/tool/.test(t)) {
      const name = ev.tool_name || ev.name || (typeof ev.tool === 'string' ? ev.tool : ev.tool && ev.tool.name) || 'ferramenta';
      const input = ev.parameters || ev.input || ev.args || ev.arguments || {};
      emit({ type: 'tool', name, detail: describeTool(name, input), input });
    } else if (/error/.test(t)) {
      emit({ type: 'error', text: short(str(ev.message) || str(ev.error) || str(ev.error && ev.error.message) || 'erro', 200) });
    } else if (/result|final|done|complete|response/.test(t) || (!t && (ev.response || ev.result))) {
      const r = str(ev.response) || str(ev.result) || str(ev.text) || str(ev.output) || str(ev.content);
      if (r) resultText = r;
      const u = ev.stats || ev.usage || (ev.stats && ev.stats.usage);
      if (u && typeof u === 'object') emit({ type: 'usage', ...usageOf(u), costUsd: 0 });
      if (ev.status && !/success|ok|complete/i.test(String(ev.status))) ok = false;
    } else if (/message|text|content|delta|assistant|model/.test(t)) {
      if (ev.role && !/assistant|model|agent/i.test(ev.role)) return;
      const c = str(ev.content) || str(ev.text) || str(ev.delta) || str(ev.message);
      if (!c) return;
      if (ev.delta === true || /delta|chunk/.test(t)) { deltas += c; emit({ type: 'text', text: c, delta: true }); }
      else { lastMsg = c; emit({ type: 'text', text: c }); }
    }
  };

  const exe = resolveAgy();
  const h = run(exe, args, {
    cwd,
    onLine(line) {
      if (fmt === 'stream-json') {
        let ev = null;
        try { ev = JSON.parse(line); } catch {}
        if (ev && typeof ev === 'object') return handleObj(ev);
      }
      raw.push(line);
      if (!fmt) emit({ type: 'text', text: line });
    },
  });
  const done = h.done.then(async (r) => {
    if (fmt === 'json' && raw.length) {
      const all = raw.join('\n');
      const a = all.indexOf('{');
      try { handleObj(JSON.parse(all.slice(a))); raw.length = 0; } catch {}
    }
    // Formato de saída não suportado por esta versão: tenta o próximo (stream-json → json → texto).
    if (!sawJson && fmt && r.code !== 0 && /output-format|unknown|invalid|unrecognized|não reconhecid/i.test(r.stderr) && fmtIdx < AGY_FORMATS.length - 1) {
      const again = runAntigravity({ prompt, cwd, model, readOnly, autonomy, tools, emit }, fmtIdx + 1);
      h.child.__replacement = again.child;
      return again.done;
    }
    let final = resultText || deltas || lastMsg;
    if (!final && objs.length) final = textFromAny(objs);
    if (!final) final = raw.filter((l) => !/^(Loaded cached credentials|Data collection)/i.test(l)).join('\n').trim();
    if (r.code !== 0 && !final) { ok = false; emit({ type: 'error', text: explainFailure('Antigravity (agy)', r.stderr) }); }
    return { ok: ok && !!final, final };
  });
  return { child: h.child, done };
}

function explainFailure(name, stderr) {
  const s = String(stderr || '');
  if (/not recognized|ENOENT|command not found|reconhecido/i.test(s)) return `${name} não está instalado neste PC. Vá em Ajustes → Contas e clique em Instalar.`;
  if (/no longer supported|antigravity\.google/i.test(s)) return `${name}: a Google desativou o Gemini CLI para contas pessoais. Use o Antigravity (Ajustes → Contas → Instalar).`;
  if (/login|auth|unauthori[sz]ed|401|credential|sign in/i.test(s)) return `${name} pediu login. Abra Ajustes → Contas → Fazer login.`;
  if (/rate|limit|quota|429|usage/i.test(s)) return `${name} atingiu o limite da assinatura. Tente mais tarde ou troque o agente de IA.`;
  return `${name} falhou: ${short(s.split('\n').filter(Boolean).slice(-3).join(' '), 220) || 'sem detalhes'}`;
}

const PROVIDERS = {
  claude: { label: 'Claude', cli: 'claude', run: runClaude, loginCmd: 'claude', pkg: '@anthropic-ai/claude-code', versionArgs: ['--version'] },
  codex: { label: 'ChatGPT · Codex', cli: 'codex', run: runCodex, loginCmd: 'codex login', pkg: '@openai/codex', versionArgs: ['--version'] },
  gemini: { label: 'Gemini · Antigravity', cli: 'agy', bin: resolveAgy, run: runAntigravity, loginCmd: 'agy', installer: 'antigravity', versionArgs: ['--version'] },
};

function stopHandle(h) {
  if (!h) return;
  killTree(h.child);
  if (h.child && h.child.__replacement) killTree(h.child.__replacement);
}

module.exports = { PROVIDERS, describeTool, stopHandle, short, CLAUDE_TOOL_GROUPS, resolveAgy };
