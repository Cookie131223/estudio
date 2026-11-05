// O "cérebro" do Estúdio: recebe um pedido, faz o coordenador montar um plano,
// distribui as tarefas entre os agentes (Claude, Codex, Gemini), passa os resultados
// adiante e junta tudo numa resposta final. Não depende do Electron (dá para testar com node).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROVIDERS, stopHandle, short } = require('./providers');

const PROVIDER_LABEL = { claude: 'Claude', codex: 'ChatGPT (Codex)', gemini: 'Gemini' };
const MAX_TASKS_PER_STEP = 6;
const RESULT_CHARS = 5000;

const uid = () => crypto.randomBytes(5).toString('hex');
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n[…cortado…]' : s; };

class Orchestrator {
  constructor({ store, approvals, emit, mcp }) {
    this.store = store;
    this.approvals = approvals;
    this.emit = emit || (() => {});
    this.mcp = mcp; // { nodePath, scriptPath }
    this.tasks = new Map(); // taskId -> { agentId, cwd, handle }
    this.run = null;
  }

  get busy() { return !!this.run; }

  projectDir() {
    let dir = this.store.settings.projectDir;
    if (!dir) {
      dir = path.join(this.store.dir, 'projeto');
      this.store.setSettings({ projectDir: dir });
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Usado pelo servidor de aprovações para saber de quem é cada pedido. */
  contextFor(taskId) {
    const t = this.tasks.get(String(taskId));
    if (!t) return null;
    return { agentId: t.agentId, cwd: t.cwd, autonomy: this.store.settings.autonomy };
  }

  /** Conta quantas aprovações cada tarefa pediu (aba Dados). */
  noteApproval(taskId) {
    const t = this.tasks.get(String(taskId));
    if (t && t.rec) t.rec.approvals++;
  }

  setState(agentId, state, detail = '') { this.emit({ kind: 'agentState', agentId, state, detail }); }

  message(m) {
    const msg = { id: uid(), at: Date.now(), ...m };
    this.store.addMessage(msg);
    this.emit({ kind: 'message', ...msg });
    return msg;
  }

  /* --------------------------------------------------------------------- */

  async ask({ text, target = 'team' }) {
    text = String(text || '').trim();
    if (!text) return;
    if (this.run) {
      this.emit({ kind: 'notice', text: 'O time ainda está trabalhando. Espere terminar ou aperte Parar.' });
      return;
    }
    const run = this.run = { id: uid(), stopped: false, results: [], started: Date.now(), target };
    this.store.addRequest({ id: run.id, at: run.started, target, text: short(text, 200) });
    this.message({ role: 'user', text, target, runId: run.id });
    this.emit({ kind: 'run', status: 'start', runId: run.id, target });

    try {
      let final;
      if (target !== 'team') {
        const agent = this.store.agent(target);
        if (!agent) throw new Error('Agente não encontrado.');
        const r = await this.runAgent(agent, this.directPrompt(agent, text), { run, label: 'conversa' });
        final = { agentId: agent.id, text: r.text || (r.ok ? '(sem resposta)' : `Não consegui concluir. ${r.error || 'Veja os detalhes no painel ao vivo.'}`) };
      } else {
        final = await this.teamFlow(run, text);
      }
      if (run.stopped) return;
      this.message({ role: 'agent', agentId: final.agentId, text: final.text, runId: run.id });
      this.emit({ kind: 'run', status: 'done', runId: run.id });
    } catch (e) {
      if (!run.stopped) {
        this.message({ role: 'system', text: `Erro: ${e.message}`, runId: run.id });
        this.emit({ kind: 'run', status: 'error', runId: run.id, text: e.message });
      }
    } finally {
      if (this.run === run) this.run = null;
      for (const a of this.store.agents) this.setState(a.id, 'idle');
      this.emit({ kind: 'stats' });
    }
  }

  async teamFlow(run, text) {
    const agents = this.store.agents;
    const lead = this.store.lead();
    if (!lead) throw new Error('Nenhum agente no time.');

    // 1) Reunião: todo mundo vai para a mesa enquanto o coordenador planeja.
    for (const a of agents) this.setState(a.id, 'meeting', a.id === lead.id ? 'Planejando' : 'Na reunião');
    this.emit({ kind: 'run', status: 'plan', runId: run.id });
    const planRes = await this.runAgent(lead, this.planPrompt(lead, text), { run, readOnly: true, label: 'plano', keepState: 'meeting' });
    if (run.stopped) return null;

    if (!planRes.ok && !planRes.text) {
      throw new Error(`${lead.name} (coordenador) não conseguiu responder. ${planRes.error || ''}`.trim());
    }
    const plan = parsePlan(planRes.text, agents);
    if (plan && plan.resposta) return { agentId: lead.id, text: plan.resposta };

    let steps = plan && plan.etapas.length ? plan.etapas : [[{ agentId: lead.id, task: text }]];
    steps = steps.map((tasks) => expandTeams(tasks, this.store));
    const summary = (plan && plan.resumo) || 'Vou cuidar disso.';

    const involved = new Set(steps.flat().map((t) => t.agentId));
    this.message({
      role: 'plan', agentId: lead.id, runId: run.id, text: summary,
      steps: steps.map((s) => s.map((t) => ({ agentId: t.agentId, task: short(t.task, 160) }))),
    });
    for (const a of agents) this.setState(a.id, involved.has(a.id) ? 'assigned' : 'idle');

    // 2) Execução: etapas em sequência, tarefas da mesma etapa em paralelo.
    for (let i = 0; i < steps.length; i++) {
      if (run.stopped) return null;
      this.emit({ kind: 'run', status: 'step', runId: run.id, step: i + 1, total: steps.length });
      const prev = run.results.slice();
      await Promise.all(steps[i].map(async (t) => {
        const agent = this.store.agent(t.agentId);
        const r = await this.runAgent(agent, this.taskPrompt(agent, text, summary, t, prev), { run, label: `etapa ${i + 1}` });
        run.results.push({ agentId: agent.id, task: t.task, ok: r.ok, text: r.text });
        if (!run.stopped) this.setState(agent.id, 'done', r.ok ? 'Pronto!' : 'Deu problema');
      }));
    }
    if (run.stopped) return null;

    // 3) Integração: se teve mais de uma tarefa, o coordenador junta tudo.
    if (run.results.length === 1) return { agentId: run.results[0].agentId, text: run.results[0].text || '(sem resposta)' };
    this.setState(lead.id, 'meeting', 'Juntando as entregas');
    const integ = await this.runAgent(lead, this.integratePrompt(lead, text, run.results), { run, readOnly: true, label: 'integração', keepState: 'meeting' });
    return { agentId: lead.id, text: integ.text || run.results.map((r) => `**${this.store.agent(r.agentId)?.name}**: ${r.text}`).join('\n\n') };
  }

  /* --------------------------------------------------------------------- */

  async runAgent(agent, prompt, { run, readOnly = false, label = '', keepState } = {}) {
    const provider = PROVIDERS[agent.provider];
    if (!provider) return { ok: false, text: `IA desconhecida: ${agent.provider}` };
    const taskId = uid();
    const cwd = this.projectDir();
    const autonomy = this.store.settings.autonomy;
    const rec = {
      id: taskId, runId: run && run.id, agentId: agent.id, provider: agent.provider,
      model: agent.model || 'padrão', label, start: Date.now(), end: 0, ok: false,
      input: 0, cached: 0, output: 0, costUsd: 0, files: 0, approvals: 0, tools: 0,
    };
    this.tasks.set(taskId, { agentId: agent.id, cwd, handle: null, rec });

    let mcpConfigPath = null;
    if (agent.provider === 'claude' && this.mcp && this.approvals) {
      const dir = path.join(this.store.dir, 'mcp');
      fs.mkdirSync(dir, { recursive: true });
      mcpConfigPath = path.join(dir, `${taskId}.json`);
      fs.writeFileSync(mcpConfigPath, JSON.stringify(this.approvals.mcpConfig({ taskId, ...this.mcp }), null, 1));
    }

    this.setState(agent.id, keepState || 'working', label === 'plano' ? 'Planejando' : 'Trabalhando');
    this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'status', text: `Começou (${label || 'tarefa'}) · ${PROVIDER_LABEL[agent.provider]}${agent.model ? ' · ' + agent.model : ''}` });

    let deltaBuf = '';
    let lastError = '';
    const flushDelta = () => {
      if (deltaBuf.trim()) this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'text', text: short(deltaBuf, 400) });
      deltaBuf = '';
    };
    const emitEv = (ev) => {
      if (run && run.stopped) return;
      switch (ev.type) {
        case 'session':
          if (ev.model) rec.model = ev.model;
          break;
        case 'text':
          if (ev.delta) { deltaBuf += ev.text; if (deltaBuf.length > 600) flushDelta(); }
          else this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'text', text: short(ev.text, 400) });
          break;
        case 'thinking':
          this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'thinking', text: ev.text });
          break;
        case 'tool':
          flushDelta();
          rec.tools++;
          if (/^(Write|Edit|MultiEdit|NotebookEdit|write_file|replace|write_to_file|replace_file_content|multi_replace_file_content|sed_file)$/.test(ev.name)) rec.files++;
          this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'tool', tool: ev.name, text: ev.detail });
          break;
        case 'tool_result':
          if (!ev.ok) this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'warn', text: `Falhou: ${ev.detail}` });
          break;
        case 'usage':
          rec.input += ev.input || 0; rec.cached += ev.cached || 0; rec.output += ev.output || 0; rec.costUsd += ev.costUsd || 0;
          break;
        case 'usage_total':
          rec.input = ev.input || 0; rec.cached = ev.cached || 0; rec.output = ev.output || 0;
          break;
        case 'limits':
          this.store.setLimits(agent.provider, ev.data);
          this.emit({ kind: 'limits', provider: agent.provider, data: ev.data });
          break;
        case 'error':
          lastError = ev.text;
          this.emit({ kind: 'activity', agentId: agent.id, taskId, type: 'error', text: ev.text });
          break;
        default:
      }
    };

    const handle = provider.run({
      prompt, cwd, model: agent.model, effort: agent.effort, readOnly, autonomy,
      tools: agent.tools || {}, mcpConfigPath, emit: emitEv,
    });
    this.tasks.get(taskId).handle = handle;
    if (run) (run.handles = run.handles || []).push(handle);

    let result;
    try { result = await handle.done; } catch (e) { result = { ok: false, final: '' }; emitEv({ type: 'error', text: e.message }); }
    flushDelta();

    this.tasks.delete(taskId);
    this.approvals && this.approvals.denyAll((r) => r.taskId === taskId);
    if (mcpConfigPath) { try { fs.rmSync(mcpConfigPath, { force: true }); } catch {} }

    rec.end = Date.now();
    rec.ok = !!(result && result.ok) && !(run && run.stopped);
    rec.stopped = !!(run && run.stopped);
    this.store.addTask(rec);
    this.emit({ kind: 'activity', agentId: agent.id, taskId, type: rec.ok ? 'done' : 'status', text: rec.stopped ? 'Interrompido' : rec.ok ? `Terminou em ${fmtDur(rec.end - rec.start)}` : 'Terminou com problema' });
    this.emit({ kind: 'stats' });
    return { ok: rec.ok, text: (result && result.final) || '', error: lastError };
  }

  /** Botão Parar: interrompe todo mundo na hora. Arquivos já salvos continuam lá. */
  stop() {
    const run = this.run;
    if (!run) return false;
    run.stopped = true;
    for (const h of run.handles || []) stopHandle(h);
    this.approvals && this.approvals.denyAll();
    const done = run.results.filter((r) => r.ok);
    const lines = done.map((r) => `- **${this.store.agent(r.agentId)?.name || r.agentId}**: ${short(r.text, 300)}`);
    this.message({
      role: 'system', runId: run.id,
      text: done.length
        ? `Time parado. O que já tinha sido concluído foi mantido:\n${lines.join('\n')}`
        : 'Time parado. Nenhuma tarefa tinha terminado ainda; arquivos já salvos na pasta do projeto continuam lá.',
    });
    this.emit({ kind: 'run', status: 'stopped', runId: run.id });
    for (const a of this.store.agents) this.setState(a.id, 'idle');
    this.run = null;
    return true;
  }

  /* ------------------------------ prompts ------------------------------ */

  preamble(agent) {
    const s = this.store.settings;
    return [
      `Você é ${agent.name}, um agente de IA do estúdio "${s.studioName}". Seu papel: ${agent.role}.`,
      agent.spec ? `\n${agent.spec}` : '',
      `\nVocê trabalha na pasta do projeto: ${this.projectDir()}. Não leia nem escreva fora dela.`,
      'Responda sempre em português do Brasil.',
    ].join('\n');
  }

  recentConversation(filter, n = 6) {
    const msgs = this.store.data.messages.filter(filter).slice(-n);
    if (!msgs.length) return '';
    return '\nConversa recente:\n' + msgs.map((m) => {
      const who = m.role === 'user' ? 'Usuário' : (this.store.agent(m.agentId)?.name || 'Time');
      return `${who}: ${short(m.text, 500)}`;
    }).join('\n') + '\n';
  }

  directPrompt(agent, text) {
    return [
      this.preamble(agent),
      this.recentConversation((m) => (m.target === agent.id || m.agentId === agent.id) && m.role !== 'plan' && m.text !== text),
      `\nMensagem do usuário:\n"""\n${text}\n"""`,
    ].join('\n');
  }

  planPrompt(lead, text) {
    const roster = this.store.agents.map((a) => `- id: ${a.id} | ${a.name} | ${a.role} | IA: ${PROVIDER_LABEL[a.provider]}${a.team.length ? ` | equipe fixa com: ${a.team.join(', ')}` : ''}`).join('\n');
    return `${this.preamble(lead)}

Você é o coordenador do time. Agentes disponíveis:
${roster}
${this.recentConversation((m) => (m.target === 'team' || !m.target) && m.role !== 'plan')}
Pedido do usuário:
"""
${text}
"""

Monte um plano curto. Regras:
- Use só os agentes necessários. Pedido simples = 1 agente.
- Tarefas da mesma etapa rodam em paralelo; as etapas rodam em sequência e cada etapa recebe o resultado das anteriores.
- Escreva cada tarefa de forma autocontida, dizendo o que entregar.
- Agentes com equipe fixa levam os parceiros automaticamente; não precisa repetir o parceiro.
- Se for só um cumprimento ou uma pergunta rápida que você mesmo responde sem mexer em arquivos, responda direto.

Responda SOMENTE com JSON, sem texto antes ou depois, em um destes formatos:
{"resposta":"sua resposta direta ao usuário"}
{"resumo":"uma frase para o usuário dizendo o que o time vai fazer","etapas":[{"tarefas":[{"agente":"id","tarefa":"..."}]}]}`;
  }

  taskPrompt(agent, text, summary, t, prev) {
    const prevTxt = prev.length
      ? '\nResultados das etapas anteriores:\n' + prev.map((r) => `### ${this.store.agent(r.agentId)?.name} (${this.store.agent(r.agentId)?.role})\n${clip(r.text, RESULT_CHARS)}`).join('\n\n') + '\n'
      : '';
    return `${this.preamble(agent)}

Pedido original do usuário:
"""
${text}
"""
Plano do coordenador: ${summary}
${prevTxt}
SUA TAREFA AGORA:
${t.task}

Ao terminar, responda com um resumo curto do que você fez: arquivos criados ou alterados, decisões tomadas e o que ficou pendente.`;
  }

  integratePrompt(lead, text, results) {
    const body = results.map((r) => {
      const a = this.store.agent(r.agentId);
      return `### ${a?.name} — ${a?.role}${r.ok ? '' : ' (com problema)'}\nTarefa: ${short(r.task, 300)}\n${clip(r.text, RESULT_CHARS)}`;
    }).join('\n\n');
    return `${this.preamble(lead)}

O time terminou o trabalho. Pedido original do usuário:
"""
${text}
"""

Resultados de cada agente:
${body}

Escreva a resposta final para o usuário: o que foi feito, onde estão os arquivos e o que falta (se faltar algo).
Seja direto, use tópicos curtos. Não invente nada que não esteja nos resultados. Não mexa em arquivos.`;
  }
}

/* ------------------------------ helpers ------------------------------ */

function extractJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function parsePlan(text, agents) {
  const j = extractJson(text);
  if (!j) return null;
  if (typeof j.resposta === 'string' && j.resposta.trim()) return { resposta: j.resposta.trim() };
  const ids = new Set(agents.map((a) => a.id));
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a.id]));
  const etapas = [];
  for (const e of Array.isArray(j.etapas) ? j.etapas : []) {
    const list = Array.isArray(e) ? e : (e && e.tarefas) || [];
    const tasks = [];
    for (const t of list) {
      if (!t) continue;
      let id = String(t.agente || t.agent || '').trim();
      if (!ids.has(id)) id = byName.get(id.toLowerCase()) || '';
      const task = String(t.tarefa || t.task || '').trim();
      if (id && task) tasks.push({ agentId: id, task });
    }
    if (tasks.length) etapas.push(tasks.slice(0, MAX_TASKS_PER_STEP));
  }
  return { resumo: typeof j.resumo === 'string' ? j.resumo : '', etapas };
}

/** Quem tem equipe fixa leva os parceiros junto, cada um na sua parte. */
function expandTeams(tasks, store) {
  const out = [...tasks];
  const present = new Set(tasks.map((t) => t.agentId));
  for (const t of tasks) {
    const a = store.agent(t.agentId);
    for (const pid of (a && a.team) || []) {
      const p = store.agent(pid);
      if (!p || present.has(pid) || out.length >= MAX_TASKS_PER_STEP) continue;
      present.add(pid);
      out.push({
        agentId: pid,
        task: `${t.task}\n\n(Você está em equipe fixa com ${a.name}, que cuida de ${a.role}. Faça só a sua parte: ${p.role}. Não sobrescreva o que é da parte de ${a.name}.)`,
      });
    }
  }
  return out;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

module.exports = { Orchestrator, parsePlan, extractJson, expandTeams };
