// Voz dos agentes: cada um fala com uma voz própria.
// Motor "system": vozes do Windows/navegador (grátis). Motor "eleven": ElevenLabs (mais natural),
// com volta automática para a voz do Windows se a chave falhar ou os créditos acabarem.

const PITCHES = [1, 0.82, 1.18, 0.94, 1.1, 0.88, 1.24, 1.04, 0.9];
const RATES = [1.05, 1.0, 1.08, 0.98, 1.06, 1.02, 1.1, 1.0, 0.97];

export function cleanForSpeech(md, full = false) {
  let t = String(md || '')
    .replace(/```[\s\S]*?```/g, ' (trecho de código) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|[*#>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const max = full ? 1400 : 320;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf(': '));
    t = (end > 80 ? cut.slice(0, end + 1) : cut + '…') + ' Os detalhes estão no painel.';
  }
  return t;
}

export function createVoice({ api, getSettings, getAgents, office, toast }) {
  let queue = [];
  let current = null;
  let audioEl = null;
  let sysVoices = [];
  let elevenVoices = [];
  let warned = false;
  const hasSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window;

  function loadSystemVoices() {
    if (!hasSpeech) return;
    const all = speechSynthesis.getVoices();
    const pt = all.filter((v) => /^pt/i.test(v.lang));
    const score = (v) => (v.lang === 'pt-BR' ? 4 : 0) + (/natural|online/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
    sysVoices = (pt.length ? pt : all).slice().sort((a, b) => score(b) - score(a));
  }
  if (hasSpeech) { loadSystemVoices(); speechSynthesis.addEventListener('voiceschanged', loadSystemVoices); }

  const indexOf = (id) => Math.max(0, getAgents().findIndex((a) => a.id === id));
  const shortName = (v) => v.name.replace(/^Microsoft\s+/i, '').replace(/\s*[-–]\s*Portuguese.*$/i, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();

  function systemVoiceFor(agent) {
    const i = indexOf(agent.id);
    let v = agent.voiceSystem && sysVoices.find((x) => x.voiceURI === agent.voiceSystem);
    if (!v) v = sysVoices.length ? sysVoices[i % sysVoices.length] : null;
    // Com poucas vozes instaladas, o tom e a velocidade mudam de agente para agente.
    return { v, pitch: agent.voiceSystem ? 1 : PITCHES[i % PITCHES.length], rate: RATES[i % RATES.length] };
  }

  function elevenVoiceFor(agent) {
    if (agent.voiceEleven) return elevenVoices.find((x) => x.id === agent.voiceEleven) || { id: agent.voiceEleven, name: 'escolhida' };
    if (!elevenVoices.length) return null;
    return elevenVoices[indexOf(agent.id) % elevenVoices.length];
  }

  function playSystem(agent, text) {
    return new Promise((resolve) => {
      if (!hasSpeech) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const { v, pitch, rate } = systemVoiceFor(agent);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'pt-BR';
      u.pitch = pitch; u.rate = rate;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  async function playEleven(agent, text) {
    const v = elevenVoiceFor(agent);
    if (!v) throw new Error('nenhuma voz da ElevenLabs carregada');
    const r = await api.voice('tts', { text, voiceId: v.id });
    if (!r || r.error) throw new Error((r && r.error) || 'sem resposta');
    if (current && current.cancelled) return;
    await new Promise((resolve) => {
      audioEl = new Audio(`data:${r.mime};base64,${r.audio}`);
      audioEl.onended = () => resolve();
      audioEl.onerror = () => resolve();
      audioEl.play().catch(() => resolve());
    });
  }

  async function pump() {
    if (current || !queue.length) return;
    const item = current = queue.shift();
    const agent = getAgents().find((a) => a.id === item.agentId) || { id: item.agentId, name: '' };
    const est = Math.min(30000, 800 + item.text.length * 70);
    if (office && item.bubble !== false) office.say(agent.id, '🔊 ' + item.text.slice(0, 46) + (item.text.length > 46 ? '…' : ''), est);
    try {
      const engine = item.engine || (getSettings().voice || {}).engine || 'system';
      if (engine === 'eleven') {
        try { await playEleven(agent, item.text); } catch (e) {
          if (!warned) { warned = true; toast(`ElevenLabs indisponível (${e.message}). Usando a voz do Windows.`); }
          if (!item.cancelled) await playSystem(agent, item.text);
        }
      } else {
        await playSystem(agent, item.text);
      }
    } finally {
      if (office) office.say(agent.id, '', 1);
      current = null;
      pump();
    }
  }

  return {
    /** Fala um texto com a voz do agente (se a voz estiver ligada, ou com force). */
    speak(agentId, text, { force = false, engine, full } = {}) {
      const vs = getSettings().voice || {};
      if (!force && !vs.enabled) return;
      const clean = cleanForSpeech(text, full ?? vs.full);
      if (!clean) return;
      queue.push({ agentId, text: clean, engine });
      if (queue.length > 4) queue = queue.slice(-4);
      pump();
    },
    stop() {
      queue = [];
      if (current) current.cancelled = true;
      if (hasSpeech) speechSynthesis.cancel();
      if (audioEl) { try { audioEl.pause(); } catch {} }
    },
    preview(agent, engine) {
      this.stop();
      warned = false;
      setTimeout(() => this.speak(agent.id, `Oi, eu sou ${agent.name}. ${agent.role}.`, { force: true, engine }), 60);
    },
    setElevenVoices(list) { elevenVoices = Array.isArray(list) ? list : []; },
    systemVoices: () => sysVoices.map((v) => ({ id: v.voiceURI, name: shortName(v), lang: v.lang })),
    autoLabel(agent, engine) {
      if (engine === 'eleven') { const v = elevenVoiceFor(agent); return v ? v.name : 'sem vozes'; }
      const { v } = systemVoiceFor(agent);
      return v ? shortName(v) : 'voz padrão';
    },
    get speaking() { return !!current; },
  };
}
