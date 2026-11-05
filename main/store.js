// Persistência simples em JSON (pasta de dados do app).
const fs = require('fs');
const path = require('path');
const { DEFAULT_AGENTS, DEFAULT_SETTINGS, TOOLS_ALL } = require('./defaults');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'estudio.json');
    fs.mkdirSync(dir, { recursive: true });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      agents: Array.isArray(data.agents) && data.agents.length ? data.agents : JSON.parse(JSON.stringify(DEFAULT_AGENTS)),
      tasks: Array.isArray(data.tasks) ? data.tasks : [],       // histórico de tarefas (para a aba Dados)
      requests: Array.isArray(data.requests) ? data.requests : [], // pedidos do usuário
      messages: Array.isArray(data.messages) ? data.messages : [], // conversa
      limits: data.limits || {},                                  // último limite informado por provedor
      secrets: data.secrets || {},                                // chave da ElevenLabs (só neste PC)
    };
    if (!this.data.settings.studioName || this.data.settings.studioName === 'Meu Estúdio') this.data.settings.studioName = DEFAULT_SETTINGS.studioName;
    for (const a of this.data.agents) {
      a.tools = { ...TOOLS_ALL, ...(a.tools || {}) };
      a.team = Array.isArray(a.team) ? a.team : [];
    }
    this._t = null;
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this._t);
    const d = this.data;
    // mantém o arquivo pequeno
    d.tasks = d.tasks.slice(-2000);
    d.requests = d.requests.slice(-1000);
    d.messages = d.messages.slice(-300);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
    fs.renameSync(tmp, this.file);
  }

  get settings() { return this.data.settings; }
  get agents() { return this.data.agents; }
  agent(id) { return this.data.agents.find((a) => a.id === id); }
  lead() { return this.data.agents.find((a) => a.isLead) || this.data.agents[0]; }

  setSettings(patch) { Object.assign(this.data.settings, patch); this.save(); return this.data.settings; }

  upsertAgent(agent) {
    const a = { ...agent };
    if (!a.id) a.id = slug(a.name) || 'agente';
    a.team = (a.team || []).filter((t) => t !== a.id).slice(0, 3);
    a.tools = { ...TOOLS_ALL, ...(a.tools || {}) };
    const i = this.data.agents.findIndex((x) => x.id === a.id);
    if (i >= 0) this.data.agents[i] = { ...this.data.agents[i], ...a };
    else {
      let id = a.id, n = 2;
      while (this.agent(id)) id = `${a.id}-${n++}`;
      a.id = id;
      this.data.agents.push(a);
    }
    if (a.isLead) for (const x of this.data.agents) if (x.id !== a.id) x.isLead = false;
    // equipe fixa é recíproca
    for (const x of this.data.agents) {
      if (x.id === a.id) continue;
      const should = a.team.includes(x.id);
      const has = x.team.includes(a.id);
      if (should && !has && x.team.length < 3) x.team.push(a.id);
      if (!should && has) x.team = x.team.filter((t) => t !== a.id);
    }
    this.save();
    return this.agent(a.id);
  }

  deleteAgent(id) {
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    for (const a of this.data.agents) a.team = a.team.filter((t) => t !== id);
    if (!this.data.agents.some((a) => a.isLead) && this.data.agents[0]) this.data.agents[0].isLead = true;
    this.save();
  }

  addTask(t) { this.data.tasks.push(t); this.save(); }
  addRequest(r) { this.data.requests.push(r); this.save(); }
  addMessage(m) { this.data.messages.push(m); this.save(); }
  setLimits(provider, data) { this.data.limits[provider] = { at: Date.now(), data }; this.save(); }
}

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

module.exports = { Store, slug };
