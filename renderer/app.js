import { renderMarkdown, esc } from './md.js';
import { createVoice } from './voice.js';
import { initCopilot } from './copilot.js';
import { openProjectPicker, onlineAccountsHtml, bindOnlineAccounts, handleTermEvent, onlineSecurityHtml, bindOnlineSecurity } from './online-ui.js';

/* -------------------------------------------------------------------------- */
/* API: no app é o preload do Electron; fora dele (prévia) usa uma simulação. */
/* -------------------------------------------------------------------------- */
let api = window.estudio;
if (!api && location.protocol.startsWith('http')) {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (r.ok && (await r.json()).ok) api = (await import('./web-api.js')).createWebApi();
  } catch {}
}
if (!api) {
  const m = await import('./mock-api.js');
  api = m.createMockApi();
  document.body.classList.add('demo');
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const PROV = {
  claude: { label: 'Claude', sub: 'Assinatura do Claude (Claude Code)', models: ['sonnet', 'opus', 'haiku'] },
  codex: { label: 'ChatGPT · Codex', short: 'Codex', sub: 'Assinatura do ChatGPT (Codex CLI)', models: ['gpt-5-codex', 'gpt-5'] },
  gemini: { label: 'Gemini · Antigravity', short: 'Gemini', sub: 'Conta Google (Antigravity CLI)', models: [] },
};
const STATE_TXT = { idle: 'Disponível', meeting: 'Em reunião', assigned: 'Na fila', working: 'Trabalhando', waiting: 'Esperando aprovação', done: 'Pronto', coffee: 'No café' };
const AUTONOMY_HINT = {
  ask: 'Perguntar tudo: o time só lê sozinho. Editar, rodar comandos e usar a web pedem aprovação.',
  edits: 'Aceitar edições: editar arquivos da pasta é liberado. Comandos e web pedem aprovação.',
  auto: 'Sozinho: tudo liberado, menos o que é destrutivo (apagar, forçar push…).',
};
const COLORS = ['#e8795a', '#f2b84b', '#d9534f', '#e86fa0', '#c56cf0', '#8a7cff', '#6c8cff', '#3fb6a8', '#5fbf6a', '#b98e6a', '#9aa0a6'];

let S = { settings: {}, agents: [], messages: [], tasks: [], requests: [], limits: {}, providers: {}, pending: [], busy: false };
const agentState = {};
let target = 'team';
let period = 14;

/* ------------------------------- 3D -------------------------------------- */
let office = null;
let renderThumb = () => '';
try {
  const [{ createOffice }, ch] = await Promise.all([import('./office.js'), import('./characters.js')]);
  renderThumb = ch.renderThumb;
  office = createOffice($('#office3d'), { onAgentClick: (id) => { setTarget(id); $('#input').focus(); } });
} catch (e) {
  console.error('Escritório 3D indisponível:', e);
  $('.office-fallback').hidden = false;
  $('.office-fallback').textContent = 'Não foi possível abrir o escritório 3D. Rode "npm install" na pasta do app.';
}

const voice = createVoice({ api, getSettings: () => S.settings, getAgents: () => S.agents, office, toast: (t, bad) => toast(t, bad) });
let elevenInfo = null;
let elevenLoading = false;
async function loadEleven(force) {
  if (elevenLoading || (elevenInfo && !force) || !api.voice) return elevenInfo;
  elevenLoading = true;
  try { elevenInfo = await api.voice('info'); } catch (e) { elevenInfo = { connected: false, error: e.message }; }
  elevenLoading = false;
  voice.setElevenVoices((elevenInfo && elevenInfo.voices) || []);
  if (currentTab === 'settings') renderSettings();
  return elevenInfo;
}
const voiceSettings = () => ({ enabled: false, engine: 'system', full: false, ...(S.settings.voice || {}) });
async function setVoice(patch) {
  S.settings = await api.setSettings({ voice: { ...voiceSettings(), ...patch } });
  renderHeader();
}

const agentById = (id) => S.agents.find((a) => a.id === id);
const thumb = (a, size = 128) => (a ? renderThumb(a, size) : '');
const avatar = (a, cls = '') => `<span class="av ${cls}" style="background-image:url('${thumb(a)}');${thumb(a) ? '' : `background:${a ? a.color : '#555'}`}"></span>`;

/* ------------------------------ som ------------------------------------- */
let audio;
function beep(freqs, dur = 0.12, gap = 0.04, vol = 0.06) {
  if (!S.settings.sounds) return;
  try {
    audio = audio || new AudioContext();
    let t = audio.currentTime;
    for (const f of freqs) {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
      t += dur + gap;
    }
  } catch {}
}
let ringTimer = null;
function updateRinging() {
  const ringing = S.pending.length > 0;
  if (ringing && !ringTimer) { beep([880, 660, 880, 660]); ringTimer = setInterval(() => beep([880, 660, 880, 660]), 2600); }
  if (!ringing && ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}

function toast(text, bad = false) {
  const t = h(`<div class="toast ${bad ? 'bad' : ''}">${esc(text)}</div>`);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}

/* ------------------------------ topo ------------------------------------ */
function renderHeader() {
  $('#studioName').textContent = S.settings.studioName || 'Meu Estúdio';
  const busyN = Object.values(agentState).filter((s) => s && !['idle', 'coffee', 'done'].includes(s.state)).length;
  $('#teamStatus').textContent = S.busy
    ? `${S.agents.length} agentes · ${busyN} em ação`
    : `${S.agents.length} agentes · todos disponíveis`;
  const dir = S.settings.projectDir || '';
  $('#folderName').textContent = dir ? dir.split(/[\\/]/).filter(Boolean).pop() : 'Escolher pasta';
  $('#folderBtn').title = dir ? `Pasta do projeto: ${dir}\n(clique para trocar; Shift+clique abre a pasta)` : 'Escolha a pasta onde o time vai trabalhar';
  $$('#autonomy button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.settings.autonomy));
  $('#autoHint').textContent = AUTONOMY_HINT[S.settings.autonomy] || '';
  $('#stopBtn').disabled = !S.busy;
  $('#voiceBtn').classList.toggle('on', !!voiceSettings().enabled);
  $('#voiceBtn').title = voiceSettings().enabled ? 'Voz ligada (clique para desligar)' : 'Voz desligada (clique para ligar)';
  document.body.classList.toggle('busy', S.busy);
  $('#sendBtn').disabled = S.busy;
  if (office) {
    office.setStudioName(S.settings.studioName);
    office.setBusy(S.busy);
    const today = new Date().toDateString();
    const todays = S.tasks.filter((t) => new Date(t.start).toDateString() === today);
    const active = S.agents.filter((a) => agentState[a.id] && ['working', 'waiting', 'meeting'].includes(agentState[a.id].state));
    office.setBoard({
      title: S.busy ? (S.pending.length ? 'Esperando sua aprovação' : 'Time trabalhando') : 'Time disponível',
      sub: `Tarefas hoje: ${todays.length} · Concluídas: ${todays.filter((t) => t.ok).length}`,
      lines: active.map((a) => ({ color: a.color, text: `${a.name}: ${agentState[a.id].detail || STATE_TXT[agentState[a.id].state]}` })),
    });
  }
}

/* ---------------------------- composer ---------------------------------- */
function renderTargets() {
  const el = $('#targets');
  el.innerHTML = '';
  const team = h(`<button class="team ${target === 'team' ? 'on' : ''}" title="O coordenador divide o pedido entre o time">Time</button>`);
  team.onclick = () => setTarget('team');
  el.append(team);
  for (const a of S.agents) {
    const b = h(`<button class="${target === a.id ? 'on' : ''}" title="${esc(a.name)} · ${esc(a.role)}">${avatar(a)}${esc(a.name)}</button>`);
    b.onclick = () => setTarget(a.id);
    el.append(b);
  }
  const a = agentById(target);
  $('#input').placeholder = a ? `Fale direto com ${a.name} (${PROV[a.provider].short || PROV[a.provider].label})…` : 'Fale com o time…';
}
function setTarget(id) {
  target = agentById(id) ? id : 'team';
  renderTargets();
  if (office && target !== 'team') office.say(target, 'Pode falar!', 1800);
  showTab('office');
}

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || S.busy) return;
  input.value = ''; autoGrow();
  await api.ask({ text, target });
  if (!S.settings.projectDir) {
    // Sem pasta escolhida, o Estúdio usa uma pasta própria. Atualiza o nome no topo.
    setTimeout(refresh, 600);
    toast('Usando a pasta padrão do Estúdio. Para trabalhar num projeto seu, clique na pasta lá em cima.');
  }
}
function autoGrow() { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(180, i.scrollHeight) + 'px'; }

/* ------------------------------ feed ------------------------------------ */
const feed = () => $('#feed');
function scrollFeed(force) {
  const f = feed();
  if (force || f.scrollHeight - f.scrollTop - f.clientHeight < 220) f.scrollTop = f.scrollHeight;
}
function trimFeed() { const f = feed(); while (f.children.length > 500) f.firstElementChild.remove(); }
function emptyFeed() {
  if (feed().children.length) return;
  feed().append(h(`<div class="empty-feed"><b>Nada por aqui ainda</b>Escreva um pedido lá embaixo. Você vai ver aqui cada passo que o time dá, ao vivo.</div>`));
}
function addFeed(node, force) { $('.empty-feed', feed())?.remove(); feed().append(node); trimFeed(); scrollFeed(force); }

function timeOf(at) { return new Date(at || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }

function messageNode(m) {
  if (m.role === 'user') {
    const a = agentById(m.target);
    return h(`<div class="msg user">${a ? `<div class="target">para ${esc(a.name)}</div>` : ''}<div class="md">${renderMarkdown(m.text)}</div></div>`);
  }
  if (m.role === 'plan') {
    const a = agentById(m.agentId);
    const steps = (m.steps || []).map((s, i) => `<li><span class="n">ETAPA ${i + 1}</span><div>${s.map((t) => { const ag = agentById(t.agentId); return `<div class="t">${avatar(ag)}<span><b>${esc(ag ? ag.name : t.agentId)}</b> ${esc(t.task)}</span></div>`; }).join('')}</div></li>`).join('');
    return h(`<div class="msg plan"><div class="who">${avatar(a, 'lg')}${esc(a ? a.name : 'Coordenador')} montou o plano<small>${timeOf(m.at)}</small></div><div class="md">${renderMarkdown(m.text)}</div><ul class="steps">${steps}</ul></div>`);
  }
  if (m.role === 'system') return h(`<div class="msg system"><div class="md">${renderMarkdown(m.text)}</div></div>`);
  const a = agentById(m.agentId);
  return h(`<div class="msg agent"><div class="who">${avatar(a, 'lg')}${esc(a ? a.name : 'Agente')}<small>${timeOf(m.at)}</small></div><div class="md">${renderMarkdown(m.text)}</div></div>`);
}

function activityNode(ev) {
  const a = agentById(ev.agentId);
  const icon = { tool: '⚙', text: '💬', done: '✓', error: '⚠', warn: '⚠', auto: '⚡', status: '•', thinking: '…' }[ev.type] || '•';
  return h(`<div class="act ${esc(ev.type)}">${avatar(a)}<div class="tx"><b>${esc(a ? a.name : '')}</b>${icon} ${esc(ev.text)}</div></div>`);
}

function approvalNode(req) {
  const a = agentById(req.agentId);
  const detail = req.command || req.file || '';
  const n = h(`<div class="approval" data-id="${esc(req.id)}">
    <div class="who">${avatar(a, 'lg')}${esc(a ? a.name : 'Agente')} pede aprovação<span class="ring">📞 tocando</span></div>
    <div class="what">${esc(req.summary)}${req.reason ? `<div class="why">${esc(req.reason)}</div>` : ''}${detail ? `<pre>${esc(detail)}</pre>` : ''}</div>
    <div class="btns"><button class="btn ok sm" data-d="allow">Aprovar</button><button class="btn danger sm" data-d="deny">Negar</button></div>
  </div>`);
  $$('button', n).forEach((b) => { b.onclick = () => api.answer(req.id, b.dataset.d); });
  return n;
}

function renderFeedHistory() {
  feed().innerHTML = '';
  for (const m of S.messages.slice(-60)) feed().append(messageNode(m));
  for (const p of S.pending) feed().append(approvalNode(p));
  emptyFeed();
  scrollFeed(true);
}

/* ------------------------------ equipe ----------------------------------- */
function agentStats(id) {
  const ts = S.tasks.filter((t) => t.agentId === id);
  const last = ts[ts.length - 1];
  const tokens = ts.reduce((s, t) => s + (t.input || 0) + (t.output || 0), 0);
  return { done: ts.filter((t) => t.ok).length, last: last ? fmtDur(last.end - last.start) : '—', tokens: tokens ? fmtNum(tokens) : '—' };
}

function renderCards() {
  const el = $('#cards');
  el.innerHTML = '';
  for (const a of S.agents) {
    const st = agentState[a.id] || { state: 'idle' };
    const stats = agentStats(a.id);
    const teamNames = (a.team || []).map((t) => agentById(t)?.name).filter(Boolean);
    const c = h(`<div class="card">
      <div class="hero"><span class="pill" data-state="${st.state}">${STATE_TXT[st.state] || 'Disponível'}</span>${a.isLead ? '<span class="lead-badge">Coordenador</span>' : ''}<img alt="" src="${thumb(a, 256)}"></div>
      <div class="body">
        <div class="name"><b>${esc(a.name)}</b><small>${esc(PROV[a.provider].short || PROV[a.provider].label)}</small></div>
        <div class="role">${esc(a.role)}</div>
        <div class="badges">${teamNames.length ? `<span class="badge">Equipe com ${esc(teamNames.join(' e '))}</span>` : ''}</div>
        <label class="field"><span>Modelo</span><input class="input" list="models-${a.provider}" value="${esc(a.model || '')}" placeholder="padrão do ${esc(PROV[a.provider].label)}" data-k="model"></label>
        ${a.provider === 'codex' ? `<div class="field"><span>Raciocínio</span><div class="seg small" data-k="effort">${['minimal', 'low', 'medium', 'high'].map((e) => `<button data-v="${e}" class="${(a.effort || 'medium') === e ? 'on' : ''}">${{ minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto' }[e]}</button>`).join('')}</div></div>` : ''}
        <div class="stats"><div><small>Concluídas</small><b>${stats.done}</b></div><div><small>Última</small><b>${stats.last}</b></div><div><small>Tokens</small><b>${stats.tokens}</b></div></div>
        <div class="actions"><button class="btn sm" data-act="chat">Conversar</button><button class="btn sm" data-act="edit">Editar</button></div>
      </div></div>`);
    $('[data-k="model"]', c).onchange = (e) => saveAgent({ ...a, model: e.target.value.trim() });
    $$('[data-k="effort"] button', c).forEach((b) => { b.onclick = () => saveAgent({ ...a, effort: b.dataset.v }); });
    $('[data-act="chat"]', c).onclick = () => { setTarget(a.id); $('#input').focus(); };
    $('[data-act="edit"]', c).onclick = () => openEditor(a);
    el.append(c);
  }
  const add = h(`<div class="card new"><span class="plus">+</span>Novo agente</div>`);
  add.onclick = () => openEditor(null);
  el.append(add);
  // sugestões de modelo
  for (const [k, p] of Object.entries(PROV)) {
    let dl = document.getElementById(`models-${k}`);
    if (!dl) { dl = document.createElement('datalist'); dl.id = `models-${k}`; document.body.append(dl); }
    dl.innerHTML = p.models.map((m) => `<option value="${m}">`).join('');
  }
}

async function saveAgent(a) {
  await api.saveAgent(a);
  await refresh();
}

function openEditor(agent) {
  const isNew = !agent;
  const a = JSON.parse(JSON.stringify(agent || {
    name: '', role: '', provider: 'claude', model: '', effort: '', color: COLORS[Math.floor(Math.random() * COLORS.length)],
    body: 'caixa', eyes: 'pontos', antenna: false, team: [], tools: { write: true, bash: true, web: true }, spec: '',
  }));
  const modal = $('#modal');
  modal.innerHTML = '';
  const others = S.agents.filter((x) => x.id !== a.id);
  const d = h(`<div class="dialog" role="dialog">
    <div class="left">
      <div class="preview"><img alt=""></div>
      <div class="group-label">Cor</div>
      <div class="swatches">${COLORS.map((c) => `<button data-c="${c}" style="background:${c}"></button>`).join('')}<input type="color" title="Outra cor"></div>
      <div class="group-label">Corpo</div>
      <div class="seg" data-k="body"><button data-v="caixa">Caixa</button><button data-v="gota">Gota</button><button data-v="orbe">Orbe</button></div>
      <div class="group-label">Olhos</div>
      <div class="seg" data-k="eyes"><button data-v="pontos">Pontos</button><button data-v="visor">Visor</button><button data-v="sorriso">Sorriso</button></div>
      <div class="group-label">Detalhe</div>
      <label class="check"><input type="checkbox" data-k="antenna"> Antena</label>
    </div>
    <div class="right">
      <div><h1>${isNew ? 'Novo agente' : esc(a.name)}</h1><p class="sub">${isNew ? 'Dê um papel claro: é ele que o coordenador usa para escolher quem faz o quê.' : 'Mudanças valem a partir do próximo pedido.'}</p></div>
      <div class="grow">
        <label class="field"><span>Nome</span><input class="input" data-k="name" maxlength="24"></label>
        <label class="field"><span>Papel</span><input class="input" data-k="role" maxlength="70" placeholder="ex.: Testes automatizados"></label>
      </div>
      <div class="grow">
        <label class="field"><span>IA</span><select class="input" data-k="provider"><option value="claude">Claude (Claude Code)</option><option value="codex">ChatGPT (Codex CLI)</option><option value="gemini">Gemini (Antigravity CLI)</option></select></label>
        <label class="field"><span>Modelo</span><input class="input" data-k="model" placeholder="deixe vazio para o padrão"></label>
      </div>
      <label class="check"><input type="checkbox" data-k="isLead"> Coordenador do time (divide os pedidos e junta as entregas)</label>
      <div class="field"><span>Equipe fixa <em class="note">— até 3 parceiros que sempre entram junto, cada um na sua parte</em></span><div class="chips" data-k="team">${others.map((o) => `<button class="chip" data-id="${esc(o.id)}">${avatar(o)}${esc(o.name)}</button>`).join('') || '<span class="note">Crie outros agentes primeiro.</span>'}</div></div>
      <div class="field"><span>Ferramentas <em class="note">— ler arquivos é sempre liberado; o resto segue o nível de autonomia</em></span><div class="chips" data-k="tools">
        <button class="chip noav" data-t="write">Criar e editar arquivos</button><button class="chip noav" data-t="bash">Rodar comandos</button><button class="chip noav" data-t="web">Pesquisar na web</button></div></div>
      <label class="field"><span>Especificação <em class="note">— como ele trabalha, o que entrega, tom de voz</em></span><textarea class="input" data-k="spec" placeholder="Ex.: Escreve testes com Vitest. Sempre roda os testes antes de entregar."></textarea></label>
      <div class="foot">${isNew ? '' : '<button class="btn danger" data-act="del">Excluir</button>'}<span class="spacer"></span><button class="btn" data-act="cancel">Cancelar</button><button class="btn primary" data-act="save">${isNew ? 'Criar agente' : 'Salvar'}</button></div>
    </div></div>`);
  modal.append(d);
  modal.hidden = false;

  const sync = () => {
    $('.preview img', d).src = renderThumb(a, 256);
    $$('.swatches button', d).forEach((b) => b.classList.toggle('on', b.dataset.c === a.color));
    $$('[data-k="body"] button', d).forEach((b) => b.classList.toggle('on', b.dataset.v === a.body));
    $$('[data-k="eyes"] button', d).forEach((b) => b.classList.toggle('on', b.dataset.v === a.eyes));
    $$('[data-k="team"] .chip', d).forEach((b) => b.classList.toggle('on', a.team.includes(b.dataset.id)));
    $$('[data-k="tools"] .chip', d).forEach((b) => b.classList.toggle('on', a.tools[b.dataset.t] !== false));
  };
  $$('.swatches button', d).forEach((b) => { b.onclick = () => { a.color = b.dataset.c; sync(); }; });
  $('.swatches input', d).oninput = (e) => { a.color = e.target.value; sync(); };
  $$('[data-k="body"] button', d).forEach((b) => { b.onclick = () => { a.body = b.dataset.v; sync(); }; });
  $$('[data-k="eyes"] button', d).forEach((b) => { b.onclick = () => { a.eyes = b.dataset.v; sync(); }; });
  $$('[data-k="team"] .chip', d).forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      if (a.team.includes(id)) a.team = a.team.filter((t) => t !== id);
      else if (a.team.length < 3) a.team.push(id);
      else toast('No máximo 3 parceiros fixos.');
      sync();
    };
  });
  $$('[data-k="tools"] .chip', d).forEach((b) => { b.onclick = () => { a.tools[b.dataset.t] = a.tools[b.dataset.t] === false; sync(); }; });
  const ant = $('[data-k="antenna"]', d); ant.checked = !!a.antenna; ant.onchange = () => { a.antenna = ant.checked; sync(); };
  const lead = $('[data-k="isLead"]', d); lead.checked = !!a.isLead; lead.onchange = () => { a.isLead = lead.checked; };
  for (const k of ['name', 'role', 'model', 'spec', 'provider']) {
    const el = $(`[data-k="${k}"]`, d);
    el.value = a[k] || (k === 'provider' ? 'claude' : '');
    el.oninput = el.onchange = () => { a[k] = el.value; if (k === 'provider') { $('[data-k="model"]', d).setAttribute('list', `models-${a.provider}`); } };
  }
  $('[data-k="model"]', d).setAttribute('list', `models-${a.provider}`);
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  $('[data-act="cancel"]', d).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  if (!isNew) $('[data-act="del"]', d).onclick = async () => {
    if (S.agents.length <= 1) { toast('O time precisa de pelo menos um agente.', true); return; }
    if (!confirm(`Excluir ${a.name}?`)) return;
    await api.deleteAgent(a.id); close(); await refresh();
  };
  $('[data-act="save"]', d).onclick = async () => {
    a.name = a.name.trim(); a.role = a.role.trim();
    if (!a.name || !a.role) { toast('Dê um nome e um papel ao agente.', true); return; }
    if (a.provider === 'codex' && !a.effort) a.effort = 'medium';
    await api.saveAgent(a); close(); await refresh();
    toast(isNew ? `${a.name} entrou no time.` : 'Agente salvo.');
  };
  sync();
  setTimeout(() => $('[data-k="name"]', d).focus(), 50);
}

/* ------------------------------- dados ----------------------------------- */
function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const hr = Math.floor(m / 60);
  if (hr >= 48) return `${Math.round(hr / 24)} dias`;
  return `${hr} h ${m % 60} min`;
}
function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' mi';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + ' mil';
  return String(n);
}

function limitRows(data) {
  if (!data || typeof data !== 'object') return [];
  const rows = [];
  const walk = (obj, key) => {
    if (!obj || typeof obj !== 'object') return;
    const pct = obj.used_percent ?? obj.usedPercent ?? obj.utilization ?? obj.percent_used;
    if (typeof pct === 'number') {
      const win = obj.window_minutes ?? obj.windowMinutes;
      let label = key;
      if (win === 300) label = 'Limite de 5 horas';
      else if (win === 10080) label = 'Limite semanal';
      else if (win) label = `Limite de ${win >= 60 ? Math.round(win / 60) + ' h' : win + ' min'}`;
      else if (/primary|five|5h/i.test(key)) label = 'Limite de 5 horas';
      else if (/secondary|week/i.test(key)) label = 'Limite semanal';
      const resetS = obj.resets_in_seconds ?? obj.resetsInSeconds;
      const reset = resetS ? `renova em ${fmtDur(resetS * 1000)}` : obj.resets_at ? `renova ${new Date(typeof obj.resets_at === 'number' ? obj.resets_at * 1000 : obj.resets_at).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
      rows.push({ label, pct: pct <= 1 && !Number.isInteger(pct) ? pct * 100 : pct, reset });
      return;
    }
    for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') walk(v, k);
  };
  walk(data, 'Limite');
  return rows.slice(0, 3);
}

function renderData() {
  const since = Date.now() - period * 864e5;
  const tasks = S.tasks.filter((t) => t.start >= since);
  const reqs = S.requests.filter((r) => r.at >= since);
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const dur = (t) => Math.max(0, (t.end || t.start) - t.start);

  const provCards = Object.entries(PROV).map(([k, p]) => {
    const ts = tasks.filter((t) => t.provider === k);
    const ok = ts.filter((t) => t.ok).length;
    const inp = sum(ts, (t) => t.input), cached = sum(ts, (t) => t.cached), out = sum(ts, (t) => t.output), cost = sum(ts, (t) => t.costUsd);
    const lim = S.limits[k];
    const rows = limitRows(lim && lim.data);
    const limHtml = rows.length
      ? rows.map((r) => `<div style="display:flex;justify-content:space-between;font-size:12.5px"><b>${esc(r.label)}</b><span class="sub">${Math.round(r.pct)}% usado</span></div><div class="bar"><i style="width:${Math.min(100, r.pct)}%;background:${r.pct > 85 ? 'var(--bad)' : r.pct > 60 ? 'var(--warn)' : 'var(--accent)'}"></i></div>${r.reset ? `<div class="note" style="margin:-6px 0 8px">${esc(r.reset)}</div>` : ''}`).join('') + `<div class="note">Informado ${new Date(lim.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>`
      : `<div class="note" style="margin-bottom:10px">${k === 'codex' ? 'O Codex informa o limite depois da primeira tarefa.' : 'Este CLI não informa o limite da assinatura. Dá para ver tarefas e tokens.'}</div>`;
    return `<div class="tile prov"><h3>${esc(p.label)}</h3><div class="sub">${esc(p.sub)}</div>${limHtml}
      <div class="kv"><div><small>Tarefas</small><b>${ts.length}${ts.length ? `<em>${Math.round((ok / ts.length) * 100)}% ok</em>` : ''}</b></div><div><small>Tempo</small><b>${fmtDur(sum(ts, dur))}</b></div>
      <div><small>Tokens de entrada</small><b>${fmtNum(inp)}${inp ? `<em>${Math.round((cached / inp) * 100)}% cache</em>` : ''}</b></div><div><small>Tokens de saída</small><b>${fmtNum(out)}</b></div></div>
      ${cost ? `<div class="note" style="margin-top:10px">Equivale a US$ ${cost.toFixed(2)} na API. Na assinatura, não é cobrado à parte.</div>` : ''}</div>`;
  }).join('');

  // por dia
  const days = [];
  for (let i = period - 1; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const next = d.getTime() + 864e5;
    days.push({ d, n: tasks.filter((t) => t.start >= d.getTime() && t.start < next).length });
  }
  const max = Math.max(4, ...days.map((x) => x.n));
  const W = 760, H = 210, pad = 30, bw = (W - pad - 10) / days.length;
  const bars = days.map((x, i) => {
    const bh = ((H - 40) * x.n) / max;
    const lab = (period <= 14 || i % 3 === 0) ? `<text x="${pad + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle" fill="#6f665e" font-size="10">${x.d.getDate()}/${x.d.getMonth() + 1}</text>` : '';
    return `<rect x="${pad + i * bw + bw * 0.18}" y="${H - 22 - bh}" width="${bw * 0.64}" height="${Math.max(bh, x.n ? 2 : 0)}" rx="3" fill="#e8795a"><title>${x.n} tarefas</title></rect>${lab}`;
  }).join('');
  const grid = [0, 0.5, 1].map((f) => { const y = H - 22 - (H - 40) * f; return `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}" stroke="#2c2622"/><text x="${pad - 6}" y="${y + 3}" text-anchor="end" fill="#6f665e" font-size="10">${Math.round(max * f)}</text>`; }).join('');

  const perAgent = S.agents.map((a) => {
    const ts = tasks.filter((t) => t.agentId === a.id);
    const ok = ts.filter((t) => t.ok).length;
    const pct = ts.length ? Math.round((ok / ts.length) * 100) : 0;
    return { a, n: ts.length, pct, avg: ts.length ? sum(ts, dur) / ts.length : 0 };
  }).sort((x, y) => y.n - x.n);

  const models = {};
  for (const t of tasks) models[t.model] = (models[t.model] || 0) + 1;
  const mlist = Object.entries(models).sort((x, y) => y[1] - x[1]).slice(0, 6);
  const mmax = Math.max(1, ...mlist.map((m) => m[1]));

  $('#dataPage').innerHTML = `
    <div class="page-head"><div><h1>Dados</h1><p>O que o time fez e quanto de cada assinatura já foi usado.</p></div>
      <div class="seg" id="period">${[7, 14, 30].map((p) => `<button data-v="${p}" class="${p === period ? 'on' : ''}">${p} dias</button>`).join('')}</div></div>
    <h2 style="margin-top:6px">Uso por IA</h2>
    <div class="grid3">${provCards}</div>
    <h2>Resumo</h2>
    <div class="grid4">
      <div class="tile"><small>Tarefas</small><div class="big">${tasks.length}</div><div class="foot">${tasks.filter((t) => t.ok).length} concluídas · ${tasks.filter((t) => !t.ok && !t.stopped).length} com erro</div></div>
      <div class="tile"><small>Pedidos seus</small><div class="big">${reqs.length}</div><div class="foot">${reqs.filter((r) => r.target === 'team').length} para o time</div></div>
      <div class="tile"><small>Arquivos alterados</small><div class="big">${sum(tasks, (t) => t.files)}</div><div class="foot">${sum(tasks, (t) => t.approvals)} aprovações pedidas</div></div>
      <div class="tile"><small>Tempo de trabalho</small><div class="big">${fmtDur(sum(tasks, dur))}</div><div class="foot">somando todos os agentes</div></div>
    </div>
    <h2>Tarefas por dia</h2>
    <div class="tile chart" style="max-width:1260px"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${bars}</svg></div>
    <div class="grid2" style="margin-top:12px">
      <div class="tile"><small style="margin-bottom:6px">Por agente</small><table class="t"><tr><th>Agente</th><th>Tarefas</th><th>Sucesso</th><th>Tempo médio</th></tr>
        ${perAgent.map((r) => `<tr><td>${avatar(r.a)} ${esc(r.a.name)}</td><td>${r.n}</td><td><span class="mini"><i style="width:${r.pct}%"></i></span>${r.n ? r.pct + '%' : '—'}</td><td>${r.n ? fmtDur(r.avg) : '—'}</td></tr>`).join('')}</table></div>
      <div class="tile"><small style="margin-bottom:10px">Por modelo</small>${mlist.length ? mlist.map(([m, n]) => `<div style="display:flex;justify-content:space-between;font-size:12.5px"><code style="font:12px var(--mono)">${esc(m)}</code><b>${n}</b></div><div class="bar"><i style="width:${(n / mmax) * 100}%"></i></div>`).join('') : '<div class="note">Nenhuma tarefa no período.</div>'}</div>
    </div>`;
  $$('#period button').forEach((b) => { b.onclick = () => { period = Number(b.dataset.v); renderData(); }; });
  $$('#dataPage .av').forEach((x) => { x.style.display = 'inline-block'; x.style.verticalAlign = 'middle'; x.style.width = '18px'; x.style.height = '18px'; });
}

/* ------------------------------ ajustes ---------------------------------- */
async function chooseProject() {
  if (S.online) {
    openProjectPicker({ api, toast, onPicked: (p) => { S.settings.projectDir = p; renderHeader(); if (currentTab === 'settings') renderSettings(); } });
    return null;
  }
  const d = await api.pickFolder();
  return d && typeof d === 'string' ? d : null;
}

function renderSettings() {
  const P = S.providers || {};
  const rows = Object.entries(PROV).map(([k, p]) => {
    const info = P[k] || {};
    const users = S.agents.filter((a) => a.provider === k).map((a) => a.name);
    let tag = '<span class="tag wait">verificando…</span>';
    if (info.checkedAt) tag = info.installed ? (info.loginOk === true ? '<span class="tag ok">✓ Conectado</span>' : info.loginOk === false ? '<span class="tag bad">Login com problema</span>' : '<span class="tag ok">Instalado</span>') : '<span class="tag bad">Não encontrado</span>';
    if (info.testing) tag = '<span class="tag wait">testando…</span>';
    return `<div class="row"><div class="info"><b>${esc(p.label)} ${tag}</b>
      <div>${info.version ? esc(info.version) + ' · ' : ''}${users.length ? `Usado por ${esc(users.join(', '))}` : 'Nenhum agente usa'}</div>
      ${info.loginMsg && info.loginOk === false ? `<div style="color:#ff9a8a">${esc(info.loginMsg)}</div>` : ''}
      ${k === 'gemini' && info.checkedAt && !info.installed ? `<div style="margin-top:6px">Se o terminal não abrir: abra o <b>PowerShell</b>, cole <code style="font:12px var(--mono);background:var(--bg2);padding:1px 5px;border-radius:5px">irm https://antigravity.google/cli/install.ps1 | iex</code> e aperte Enter. Depois rode <code style="font:12px var(--mono);background:var(--bg2);padding:1px 5px;border-radius:5px">agy</code> para fazer o login. <button class="btn sm" data-copy="irm https://antigravity.google/cli/install.ps1 | iex">Copiar comando</button></div>` : ''}</div>
      <button class="btn sm" data-test="${k}" ${info.installed ? '' : 'disabled'}>Testar login</button>
      <button class="btn sm ${info.checkedAt && !info.installed ? 'primary' : ''}" data-login="${k}">${info.installed || !info.checkedAt ? 'Fazer login' : 'Instalar'}</button></div>`;
  }).join('');
  $('#settingsPage').innerHTML = `
    <div class="page-head"><div><h1>Ajustes</h1><p>Contas das IAs e preferências do estúdio.</p></div></div>
    <h2 style="margin-top:6px">Contas</h2>
    ${S.online ? onlineAccountsHtml(S, PROV) : `<p class="sub" style="max-width:900px;margin-bottom:12px">Cada IA roda no programa oficial da empresa, com o login da sua assinatura. O Estúdio nunca vê nem guarda senha: o login acontece no terminal oficial de cada uma. Para garantir que nada seja cobrado por uso, o Estúdio remove chaves de API (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY…) antes de chamar os CLIs. O Gemini roda pelo Antigravity CLI (agy), que substituiu o Gemini CLI para contas pessoais.</p>
    <div class="acc">${rows}</div>`}
    <div style="margin-top:10px"><button class="btn sm" id="redetect">Verificar de novo</button></div>
    <h2>Voz</h2>
    ${voiceSectionHtml()}
    <h2>Estúdio</h2>
    <div class="form">
      <label class="field"><span>Nome do estúdio (aparece na placa do escritório)</span><input class="input" id="setName" maxlength="30" value="${esc(S.settings.studioName || '')}"></label>
      <label class="field"><span>Coordenador do time</span><select class="input" id="setLead">${S.agents.map((a) => `<option value="${esc(a.id)}" ${a.isLead ? 'selected' : ''}>${esc(a.name)} (${esc(PROV[a.provider].label)})</option>`).join('')}</select></label>
      <label class="field"><span>Pasta do projeto</span><div style="display:flex;gap:8px"><input class="input" readonly value="${esc(S.settings.projectDir || 'nenhuma')}"><button class="btn sm" id="pickDir">Trocar</button>${S.online ? '' : '<button class="btn sm" id="openDir">Abrir</button>'}</div></label>
      <label class="field"><span>Sons</span><label class="check"><input type="checkbox" id="setSounds" ${S.settings.sounds ? 'checked' : ''}> Telefone toca quando alguém precisa de aprovação</label></label>
    </div>
    ${S.online ? onlineSecurityHtml() : ''}`;
  $$('[data-test]').forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.test;
      S.providers[k] = { ...(S.providers[k] || {}), testing: true }; renderSettings();
      const r = await api.testProvider(k);
      S.providers[k] = { ...r, testing: false }; renderSettings();
      toast(r.loginOk ? `${PROV[k].label}: login funcionando.` : `${PROV[k].label}: ${r.loginMsg}`, !r.loginOk);
    };
  });
  $$('[data-login]').forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.login;
      const r = await api.openLogin(k);
      if (r && r.installing) toast(`Abri um terminal instalando o ${PROV[k].label}. Quando terminar, faça o login nele e depois clique em "Verificar de novo".`);
      else toast('Abri um terminal. Faça o login lá e depois clique em "Testar login".');
    };
  });
  bindVoiceSection();
  $$('[data-copy]').forEach((b) => {
    b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Comando copiado. Cole no PowerShell e aperte Enter.')).catch(() => toast('Não consegui copiar. Selecione o texto e copie.'));
  });
  $('#redetect').onclick = async () => { S.providers = await api.detect(); renderSettings(); };
  $('#setName').onchange = async (e) => { S.settings = await api.setSettings({ studioName: e.target.value.trim() || 'Meu Estúdio' }); renderHeader(); };
  $('#setLead').onchange = async (e) => { const a = agentById(e.target.value); if (a) { await api.saveAgent({ ...a, isLead: true }); await refresh(); } };
  $('#pickDir').onclick = async () => { const d = await chooseProject(); if (d) { S.settings.projectDir = d; renderHeader(); renderSettings(); } };
  if ($('#openDir')) $('#openDir').onclick = () => api.openFolder();
  if (S.online) {
    bindOnlineAccounts({ api, toast, refresh: async () => { await refresh(); renderSettings(); } });
    bindOnlineSecurity({ api, toast });
  }
  $('#setSounds').onchange = async (e) => { S.settings = await api.setSettings({ sounds: e.target.checked }); };
}

/* -------------------------------- voz ------------------------------------ */
let sysVoiceRetry = 0;
function voiceSectionHtml() {
  const vs = voiceSettings();
  const eng = vs.engine;
  let eleven = '';
  if (eng === 'eleven') {
    const info = elevenInfo;
    if (!info) { loadEleven(); eleven = '<div class="row"><div class="info"><div>Carregando a conta da ElevenLabs…</div></div></div>'; }
    else if (!info.connected) {
      eleven = `<div class="row"><div class="info"><b>ElevenLabs <span class="tag">não conectada</span></b>
        <div>Crie uma conta grátis em <a href="https://elevenlabs.io" target="_blank" rel="noreferrer" style="color:var(--accent2)">elevenlabs.io</a>, vá em <b>Developers → API Keys</b>, crie uma chave e cole aqui. A chave fica só neste computador.</div>
        <div class="keybox"><input class="input" id="elKey" type="password" placeholder="sk_..." autocomplete="off"><button class="btn sm primary" id="elSave">Conectar</button></div></div></div>`;
    } else {
      const sub = info.sub;
      const left = sub ? Math.max(0, sub.limit - sub.used) : null;
      const pct = sub && sub.limit ? Math.min(100, (sub.used / sub.limit) * 100) : 0;
      const reset = sub && sub.resetAt ? new Date(sub.resetAt * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
      eleven = `<div class="row"><div class="info"><b>ElevenLabs <span class="tag ok">✓ Conectada · chave ${esc(info.masked)}</span></b>
        ${sub ? `<div><b style="font-size:14px">${left.toLocaleString('pt-BR')}</b> créditos sobrando no mês${sub.tier ? ` · plano ${esc(sub.tier)}` : ''}${reset ? ` · renova em ${reset}` : ''}</div><div class="bar" style="max-width:520px"><i style="width:${pct}%;background:${pct > 85 ? 'var(--bad)' : 'var(--accent)'}"></i></div>` : `<div>${esc(info.subError || '')}</div>`}
        ${info.error ? `<div style="color:#ff9a8a">${esc(info.error)}</div>` : ''}
        <div class="note">Cada fala gasta créditos conforme o tamanho do texto. O Estúdio usa o modelo mais econômico (Flash). Sem créditos, volta para a voz do Windows sozinho.</div></div>
        <button class="btn sm" id="elRefresh">Atualizar</button><button class="btn sm danger" id="elRemove">Remover chave</button></div>`;
    }
  }
  const sys = voice.systemVoices();
  if (eng === 'system' && !sys.length && sysVoiceRetry++ < 3) setTimeout(() => currentTab === 'settings' && renderSettings(), 600);
  const list = eng === 'eleven' ? ((elevenInfo && elevenInfo.voices) || []) : sys;
  const rows = S.agents.map((a) => {
    const cur = eng === 'eleven' ? a.voiceEleven || '' : a.voiceSystem || '';
    const opts = [`<option value="">Automática (${esc(voice.autoLabel(a, eng))})</option>`]
      .concat(list.map((v) => `<option value="${esc(v.id)}" ${v.id === cur ? 'selected' : ''}>${esc(v.name)}${v.lang && v.lang !== 'pt-BR' ? ` · ${esc(v.lang)}` : ''}${v.labels && v.labels.gender ? ` · ${v.labels.gender === 'female' ? 'feminina' : v.labels.gender === 'male' ? 'masculina' : esc(v.labels.gender)}` : ''}</option>`));
    return `<div class="row voice-row">${avatar(a)}<div class="info"><b style="font-size:14px">${esc(a.name)}</b><div>${esc(a.role)}</div></div>
      <select class="input" data-vagent="${esc(a.id)}">${opts.join('')}</select>
      <button class="play" data-vplay="${esc(a.id)}" title="Ouvir uma frase de teste">▶</button></div>`;
  }).join('');
  return `<div class="acc">
    <div class="row"><div class="info"><b>Ler as respostas em voz alta</b><div>Cada agente fala com a própria voz: o plano, a resposta final e os pedidos de aprovação. Esc cala na hora.</div></div><label class="check"><input type="checkbox" id="vOn" ${vs.enabled ? 'checked' : ''}> Ligada</label></div>
    <div class="row"><div class="info"><b>De onde vem a voz</b><div>Windows é grátis e funciona sem internet. ElevenLabs soa bem mais natural e tem plano grátis com créditos por mês.</div></div><div class="seg" id="vEngine"><button data-v="system" class="${eng === 'system' ? 'on' : ''}">Windows (grátis)</button><button data-v="eleven" class="${eng === 'eleven' ? 'on' : ''}">ElevenLabs</button></div></div>
    <div class="row"><div class="info"><b>Ler a resposta inteira</b><div>Desligado: lê só o começo e avisa que o resto está no painel.</div></div><label class="check"><input type="checkbox" id="vFull" ${vs.full ? 'checked' : ''}> Inteira</label></div>
    ${eleven}
  </div>
  <div class="group-label" style="margin:16px 0 8px">Voz de cada agente</div>
  <div class="acc">${rows}</div>`;
}

function bindVoiceSection() {
  const on = $('#vOn');
  if (!on) return;
  on.onchange = async () => { await setVoice({ enabled: on.checked }); if (!on.checked) voice.stop(); };
  $('#vFull').onchange = (e) => setVoice({ full: e.target.checked });
  $$('#vEngine button').forEach((b) => {
    b.onclick = async () => { await setVoice({ engine: b.dataset.v }); if (b.dataset.v === 'eleven') await loadEleven(); renderSettings(); };
  });
  $$('[data-vagent]').forEach((sel) => {
    sel.onchange = async () => {
      const a = agentById(sel.dataset.vagent);
      const field = voiceSettings().engine === 'eleven' ? 'voiceEleven' : 'voiceSystem';
      await api.saveAgent({ ...a, [field]: sel.value });
      await refresh();
      voice.preview(agentById(a.id));
    };
  });
  $$('[data-vplay]').forEach((b) => { b.onclick = () => voice.preview(agentById(b.dataset.vplay)); });
  const save = $('#elSave');
  if (save) save.onclick = async () => {
    save.disabled = true; save.textContent = 'Conectando…';
    const r = await api.voice('setKey', { key: $('#elKey').value });
    if (!r.ok) { toast(r.error || 'Não deu certo.', true); save.disabled = false; save.textContent = 'Conectar'; return; }
    toast('ElevenLabs conectada.');
    await loadEleven(true);
  };
  const rm = $('#elRemove');
  if (rm) rm.onclick = async () => { await api.voice('removeKey'); elevenInfo = null; voice.setElevenVoices([]); await loadEleven(true); toast('Chave removida.'); };
  const rf = $('#elRefresh');
  if (rf) rf.onclick = () => loadEleven(true);
}

/* ------------------------------- abas ------------------------------------ */
let currentTab = 'office';
function showTab(tab) {
  currentTab = tab;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${tab}`));
  if (tab === 'team') renderCards();
  if (tab === 'data') renderData();
  if (tab === 'settings') renderSettings();
  if (tab === 'office' && office) office.resize();
}

/* ------------------------------ eventos ---------------------------------- */
let statsTimer = null;
let connLost = false;
let warnedMissing = false;
function handle(ev) {
  switch (ev.kind) {
    case 'agentState': {
      agentState[ev.agentId] = { state: ev.state, detail: ev.detail };
      office && office.setState(ev.agentId, ev.state, ev.detail);
      renderHeader();
      if (currentTab === 'team') renderCards();
      break;
    }
    case 'activity':
      addFeed(activityNode(ev));
      office && office.pushMonitor(ev.agentId, ev.text, ev.type);
      if (ev.type === 'tool' || ev.type === 'text') {
        const st = agentState[ev.agentId];
        if (st && st.state === 'working') { st.detail = ev.text.slice(0, 40); }
      }
      break;
    case 'message':
      S.messages.push(ev);
      addFeed(messageNode(ev), ev.role === 'user');
      if (ev.role === 'agent') {
        beep([660, 990], 0.1, 0.03, 0.05);
        if (voiceSettings().enabled) voice.speak(ev.agentId, ev.text);
        else office && office.say(ev.agentId, 'Entreguei! ✅', 3000);
      }
      if (ev.role === 'plan') voice.speak(ev.agentId, ev.text, { full: false });
      break;
    case 'approval':
      voice.speak(ev.agentId, `Preciso da sua aprovação. ${ev.summary}`);
      S.pending.push(ev);
      addFeed(approvalNode(ev), true);
      updateRinging();
      renderHeader();
      break;
    case 'approvalResolved': {
      S.pending = S.pending.filter((p) => p.id !== ev.id);
      const n = $(`.approval[data-id="${CSS.escape(ev.id)}"]`);
      if (n) {
        n.classList.add('resolved');
        n.append(h(`<div class="result" style="color:${ev.decision === 'allow' ? 'var(--ok)' : 'var(--bad)'}">${ev.decision === 'allow' ? '✓ Aprovado' : ev.by === 'parar' ? '■ Cancelado (time parado)' : '✕ Negado'}</div>`));
      }
      updateRinging();
      renderHeader();
      break;
    }
    case 'run':
      S.busy = ['start', 'plan', 'step'].includes(ev.status);
      if (ev.status === 'stopped') { voice.stop(); toast('Time parado.'); }
      if (ev.status === 'error') toast(ev.text || 'Erro', true);
      renderHeader();
      break;
    case 'stats':
      clearTimeout(statsTimer);
      statsTimer = setTimeout(refresh, 400);
      break;
    case 'limits':
      S.limits[ev.provider] = { at: Date.now(), data: ev.data };
      if (currentTab === 'data') renderData();
      break;
    case 'providers': {
      S.providers = ev.providers;
      const missing = Object.entries(ev.providers || {}).filter(([, v]) => v.checkedAt && !v.installed).map(([k]) => PROV[k].label);
      if (missing.length && !warnedMissing) {
        warnedMissing = true;
        const box = h(`<div class="msg system"><div class="md"><p><b>${esc(missing.join(', '))}</b> ${missing.length > 1 ? 'não estão instalados' : 'não está instalado'} neste PC. O Estúdio usa os programas de terminal de cada IA (Claude Code, Codex CLI e Antigravity CLI), que são diferentes dos apps.</p></div><div style="margin-top:8px"><button class="btn sm primary">Abrir Ajustes para instalar</button></div></div>`);
        $('button', box).onclick = () => showTab('settings');
        addFeed(box, true);
      }
      if (currentTab === 'settings') renderSettings();
      break;
    }
    case 'agents':
      S.agents = ev.agents;
      office && office.syncAgents(S.agents);
      renderTargets();
      break;
    case 'notice':
      toast(ev.text);
      break;
    case 'connection':
      if (!ev.ok && !connLost) { connLost = true; toast('Perdi a conexão com o Estúdio. A janela preta foi fechada?', true); }
      if (ev.ok && connLost) { connLost = false; toast('Conectado de novo.'); refresh(); }
      break;
    default:
  }
}

async function refresh() {
  const st = await api.getState();
  const msgs = S.messages;
  S = { ...st, messages: msgs.length ? msgs : st.messages };
  office && office.syncAgents(S.agents);
  if (!agentById(target)) target = 'team';
  renderHeader();
  renderTargets();
  if (currentTab === 'team') renderCards();
  if (currentTab === 'data') renderData();
  if (currentTab === 'settings') renderSettings();
}

/* ------------------------------- início ---------------------------------- */
$$('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$$('#autonomy button').forEach((b) => {
  b.onclick = async () => { S.settings = await api.setSettings({ autonomy: b.dataset.v }); renderHeader(); toast(AUTONOMY_HINT[b.dataset.v]); };
});
$$('#feedFilter button').forEach((b) => {
  b.onclick = () => { $$('#feedFilter button').forEach((x) => x.classList.toggle('on', x === b)); feed().classList.toggle('msgs', b.dataset.v === 'msgs'); };
});
$('#folderBtn').onclick = async (e) => {
  if (e.shiftKey && S.settings.projectDir && !S.online) { api.openFolder(); return; }
  const d = await chooseProject();
  if (d) { S.settings.projectDir = d; renderHeader(); toast(`Pasta do projeto: ${d}`); }
};
$('#stopBtn').onclick = () => { voice.stop(); api.stop(); };
$('#voiceBtn').onclick = async () => {
  const on = !voiceSettings().enabled;
  await setVoice({ enabled: on });
  if (!on) voice.stop();
  toast(on ? 'Voz ligada: os agentes vão falar as respostas. Esc para calar.' : 'Voz desligada.');
  if (on && voiceSettings().engine === 'eleven') loadEleven();
  if (currentTab === 'settings') renderSettings();
};
$('#sendBtn').onclick = send;
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '.') { e.preventDefault(); if (S.busy) api.stop(); }
  if (e.key === 'Escape' && !$('#modal').hidden) { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
  else if (e.key === 'Escape' && voice.speaking) voice.stop();
});

const copilot = initCopilot({ root: $('#copilotPage'), api, voice, toast: (t, bad) => toast(t, bad) });
api.onEvent((ev) => { if (ev.kind === 'copilot') copilot.onEvent(ev); else if (ev.kind === 'loginTerm') handleTermEvent(ev); else handle(ev); });
S = await api.getState();
office && office.syncAgents(S.agents);
renderHeader();
renderTargets();
renderFeedHistory();
updateRinging();
if (Object.values(S.providers || {}).some((v) => v.checkedAt)) handle({ kind: 'providers', providers: S.providers });
if (voiceSettings().engine === 'eleven') loadEleven();
window.__estudioReady = true;
