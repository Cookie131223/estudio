// Simulação usada só quando a interface abre fora do app (prévia/testes).
// Imita os mesmos eventos que o orquestrador real manda.
const AGENTS = [
  { id: 'regente', name: 'Regente', role: 'Coordena, divide o pedido e junta as entregas', provider: 'claude', model: 'sonnet', isLead: true, color: '#e8795a', body: 'caixa', eyes: 'pontos', antenna: true, team: [], tools: { write: true, bash: true, web: true }, spec: '' },
  { id: 'traco', name: 'Traço', role: 'Front-end, UX/UI e design', provider: 'claude', model: 'sonnet', color: '#f2b84b', body: 'caixa', eyes: 'visor', antenna: false, team: ['base'], tools: { write: true, bash: true, web: true }, spec: '' },
  { id: 'base', name: 'Base', role: 'Back-end, infra e banco de dados', provider: 'claude', model: 'sonnet', color: '#d9534f', body: 'caixa', eyes: 'sorriso', antenna: true, team: ['traco'], tools: { write: true, bash: true, web: true }, spec: '' },
  { id: 'farol', name: 'Farol', role: 'Pesquisa e documentação', provider: 'gemini', model: '', color: '#6c8cff', body: 'orbe', eyes: 'pontos', antenna: false, team: [], tools: { write: true, bash: true, web: true }, spec: '' },
  { id: 'lupa', name: 'Lupa', role: 'Revisão de código e testes', provider: 'codex', model: '', effort: 'medium', color: '#3fb6a8', body: 'gota', eyes: 'visor', antenna: true, team: [], tools: { write: true, bash: true, web: true }, spec: '' },
  { id: 'prisma', name: 'Prisma', role: 'Textos, conteúdo e ideias', provider: 'gemini', model: '', color: '#c56cf0', body: 'orbe', eyes: 'sorriso', antenna: true, team: [], tools: { write: true, bash: true, web: true }, spec: '' },
];

function history() {
  const tasks = [];
  const requests = [];
  const now = Date.now();
  const models = { claude: 'claude-sonnet', codex: 'gpt-5-codex', gemini: 'gemini-2.5-pro' };
  for (let d = 13; d >= 0; d--) {
    const n = d === 1 ? 14 : d < 6 ? 2 + ((d * 7) % 5) : (d % 4 === 0 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = AGENTS[(d * 3 + i) % AGENTS.length];
      const start = now - d * 864e5 - i * 600000 - 3600000;
      const dur = 30000 + ((d * 13 + i * 37) % 160) * 1000;
      tasks.push({ id: `h${d}-${i}`, agentId: a.id, provider: a.provider, model: models[a.provider], start, end: start + dur, ok: (d + i) % 9 !== 0, input: 40000 + i * 9000, cached: 30000 + i * 5000, output: 2000 + i * 700, costUsd: a.provider === 'claude' ? 0.12 + i * 0.03 : 0, files: i % 3, approvals: i % 2 });
      if (i % 3 === 0) requests.push({ id: `r${d}-${i}`, at: start, target: 'team', text: 'pedido' });
    }
  }
  return { tasks, requests };
}

export function createMockApi() {
  const listeners = new Set();
  const h = history();
  const state = {
    settings: { studioName: 'COOKIE INTERPRISE', projectDir: 'C:\\Users\\voce\\Projetos\\site-exemplo', autonomy: 'edits', sounds: false, voice: { enabled: false, engine: 'system', full: false } },
    agents: JSON.parse(JSON.stringify(AGENTS)),
    messages: [], tasks: h.tasks, requests: h.requests,
    limits: { codex: { at: Date.now() - 3600e3, data: { primary: { used_percent: 13, window_minutes: 300, resets_in_seconds: 9000 }, secondary: { used_percent: 3, window_minutes: 10080, resets_in_seconds: 259200 } } } },
    busy: false, pending: [],
    providers: { claude: { installed: true, version: '2.9.0 (Claude Code)', checkedAt: Date.now(), loginOk: true }, codex: { installed: true, version: 'codex-cli 0.70.0', checkedAt: Date.now(), loginOk: true }, gemini: { installed: true, version: '0.18.0', checkedAt: Date.now() } },
  };
  const emit = (ev) => setTimeout(() => listeners.forEach((l) => l(ev)), 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let run = null;
  const approvals = new Map();
  let n = 0;
  const uid = () => `m${++n}`;

  const message = (m) => { const msg = { id: uid(), at: Date.now(), ...m }; state.messages.push(msg); emit({ kind: 'message', ...msg }); };
  const st = (id, s, d = '') => emit({ kind: 'agentState', agentId: id, state: s, detail: d });
  const act = (id, type, text) => emit({ kind: 'activity', agentId: id, type, text });

  async function work(r, id, lines, needApproval) {
    st(id, 'working', 'Trabalhando');
    act(id, 'status', 'Começou · ' + ({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' })[state.agents.find((a) => a.id === id).provider]);
    for (const [type, text] of lines) {
      if (r.stopped) return;
      await sleep(900 + Math.random() * 900);
      act(id, type, text);
    }
    if (needApproval && !r.stopped) {
      const req = { id: uid(), agentId: id, tool: 'Bash', summary: `Rodando: ${needApproval}`, reason: 'Quer rodar um comando', command: needApproval };
      state.pending.push(req);
      emit({ kind: 'approval', ...req });
      st(id, 'waiting', 'Preciso da sua aprovação');
      const d = await new Promise((res) => approvals.set(req.id, res));
      state.pending = state.pending.filter((p) => p.id !== req.id);
      emit({ kind: 'approvalResolved', id: req.id, agentId: id, decision: d, by: r.stopped ? 'parar' : 'usuário' });
      if (r.stopped) return;
      st(id, 'working', d === 'allow' ? 'Aprovado' : 'Negado');
      await sleep(1200);
      act(id, d === 'allow' ? 'text' : 'warn', d === 'allow' ? '12 testes passaram.' : 'Segui sem rodar os testes.');
    }
    await sleep(800);
    const a = state.agents.find((x) => x.id === id);
    state.tasks.push({ id: uid(), agentId: id, provider: a.provider, model: a.model || 'padrão', start: Date.now() - 8000, end: Date.now(), ok: true, input: 30000, cached: 22000, output: 2500, costUsd: a.provider === 'claude' ? 0.09 : 0, files: 1, approvals: needApproval ? 1 : 0 });
    act(id, 'done', 'Terminou em 8 s');
    st(id, 'done', 'Pronto!');
  }

  async function teamFlow(text) {
    const r = run = { stopped: false };
    state.busy = true;
    message({ role: 'user', text, target: 'team' });
    emit({ kind: 'run', status: 'start' });
    for (const a of state.agents) st(a.id, 'meeting', a.id === 'regente' ? 'Planejando' : 'Na reunião');
    await sleep(3200);
    if (r.stopped) return;
    act('regente', 'text', 'Vou dividir: pesquisa, interface + API, revisão.');
    message({ role: 'plan', agentId: 'regente', text: 'Farol pesquisa referências, Traço e Base montam a página com o formulário, Lupa revisa no fim.', steps: [[{ agentId: 'farol', task: 'Pesquisar 3 referências de landing de turismo' }], [{ agentId: 'traco', task: 'Montar a landing (hero, destinos, formulário)' }, { agentId: 'base', task: 'Endpoint POST /contato que salva e envia e-mail' }], [{ agentId: 'lupa', task: 'Revisar o código e rodar os testes' }]] });
    for (const a of state.agents) st(a.id, ['farol', 'traco', 'base', 'lupa'].includes(a.id) ? 'assigned' : 'idle');
    await sleep(1200);
    emit({ kind: 'run', status: 'step' });
    await work(r, 'farol', [['tool', 'Pesquisando na web: landing page turismo'], ['tool', 'Abrindo booking.com/…'], ['text', 'Achei 3 padrões: foto grande, busca no topo, depoimentos.']]);
    if (r.stopped) return;
    await Promise.all([
      work(r, 'traco', [['tool', 'Lendo index.php'], ['tool', 'Criando landing.html'], ['tool', 'Criando css/landing.css'], ['text', 'Hero com busca e 6 cards de destino.']]),
      work(r, 'base', [['tool', 'Lendo config/db.php'], ['tool', 'Criando api/contato.php'], ['tool', 'Editando .env.example'], ['text', 'POST /contato valida e grava em contatos.']]),
    ]);
    if (r.stopped) return;
    await work(r, 'lupa', [['tool', 'Rodando: cat api/contato.php'], ['text', 'Faltava escapar o campo nome. Corrigi.']], 'npm test');
    if (r.stopped) return;
    st('regente', 'meeting', 'Juntando as entregas');
    await sleep(2500);
    if (r.stopped) return;
    message({ role: 'agent', agentId: 'regente', text: '**Landing pronta.**\n\n- `landing.html` + `css/landing.css`: hero com busca e 6 destinos (Traço)\n- `api/contato.php`: formulário salva em `contatos` (Base)\n- Revisão: 1 falha de escape corrigida, testes passando (Lupa)\n\nFalta: configurar o SMTP no `.env` para o e-mail sair.' });
    emit({ kind: 'run', status: 'done' });
    state.busy = false; run = null;
    for (const a of state.agents) st(a.id, 'idle');
    emit({ kind: 'stats' });
  }

  async function direct(text, id) {
    const r = run = { stopped: false };
    state.busy = true;
    message({ role: 'user', text, target: id });
    emit({ kind: 'run', status: 'start' });
    await work(r, id, [['tool', 'Lendo arquivos do projeto'], ['text', 'Analisando…']]);
    if (r.stopped) return;
    message({ role: 'agent', agentId: id, text: 'Feito! (resposta simulada nesta prévia)' });
    emit({ kind: 'run', status: 'done' });
    state.busy = false; run = null;
    st(id, 'idle');
    emit({ kind: 'stats' });
  }

  return {
    getState: async () => JSON.parse(JSON.stringify(state)),
    setSettings: async (p) => Object.assign(state.settings, p),
    saveAgent: async (a) => {
      const i = state.agents.findIndex((x) => x.id === a.id);
      if (a.isLead) state.agents.forEach((x) => { x.isLead = false; });
      if (i >= 0) state.agents[i] = { ...state.agents[i], ...a };
      else state.agents.push({ ...a, id: a.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '') || uid() });
      emit({ kind: 'agents', agents: state.agents });
      return a;
    },
    deleteAgent: async (id) => { state.agents = state.agents.filter((a) => a.id !== id); emit({ kind: 'agents', agents: state.agents }); },
    pickFolder: async () => state.settings.projectDir,
    openFolder: async () => {},
    ask: async ({ text, target }) => { if (state.busy) return; (target === 'team' ? teamFlow(text) : direct(text, target)); },
    stop: async () => {
      if (!run) return false;
      run.stopped = true; run = null; state.busy = false;
      for (const [, res] of approvals) res('deny');
      approvals.clear();
      message({ role: 'system', text: 'Time parado. O que já tinha sido concluído foi mantido.' });
      emit({ kind: 'run', status: 'stopped' });
      for (const a of state.agents) st(a.id, 'idle');
      return true;
    },
    answer: async (id, d) => { const r = approvals.get(id); if (r) { approvals.delete(id); r(d); } },
    detect: async () => state.providers,
    testProvider: async (k) => ({ ...state.providers[k], loginOk: true, loginMsg: 'Login funcionando.' }),
    openLogin: async () => true,
    voice: async (op) => (op === 'info' ? { connected: false } : { error: 'Prévia sem ElevenLabs' }),
    copilot: async (op) => {
      if (op === 'tip') { await sleep(1500); return { dica: 'Prévia: no app de verdade, o Claude olha a sua tela e diz o próximo passo aqui.', nova: true, acao: null, ms: 1500 }; }
      if (op === 'control') return { on: false, error: 'Na prévia não dá para controlar o mouse.' };
      return { control: false, windows: false };
    },
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
