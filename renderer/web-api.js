// Liga a interface ao servidor local (server.js) quando o Estúdio abre no navegador.
export function createWebApi() {
  const post = async (p, body) => {
    const r = await fetch('/api/' + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-estudio': '1' },
      body: JSON.stringify(body ?? {}),
    });
    if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erro ${r.status}`);
    return r.json();
  };
  return {
    getState: () => fetch('/api/state', { cache: 'no-store' }).then((r) => { if (r.status === 401) { location.href = '/login'; } return r.json(); }),
    online: (op, payload) => post(`online/${op}`, payload || {}),
    setSettings: (p) => post('settings', p),
    saveAgent: (a) => post('agent/save', a),
    deleteAgent: (id) => post('agent/delete', { id }),
    pickFolder: async () => {
      const r = await post('folder/pick');
      if (r && r.path) return r.path;
      if (r && r.online) return { online: true };
      if (r && r.manual) {
        const typed = window.prompt('Cole o caminho da pasta do projeto:');
        if (!typed) return null;
        const s = await post('folder/set', { path: typed });
        if (!s.path) window.alert('Essa pasta não existe.');
        return s.path || null;
      }
      return null;
    },
    openFolder: () => post('folder/open'),
    setFolder: async (p) => (await post('folder/set', { path: p })).path,
    ask: (req) => post('ask', req),
    stop: () => post('stop'),
    answer: (id, decision) => post('answer', { id, decision }),
    detect: () => post('detect'),
    testProvider: (key) => post('test', { key }),
    openLogin: (key) => post('login', { key }),
    voice: (op, payload) => post('voice', { ...(payload || {}), op }),
    copilot: (op, payload) => (op === 'status' ? fetch('/api/copilot/status').then((r) => r.json()) : post(`copilot/${op}`, payload || {})),
    onEvent: (cb) => {
      const es = new EventSource('/api/events');
      es.onmessage = (e) => { try { cb(JSON.parse(e.data)); } catch {} };
      es.onopen = () => cb({ kind: 'connection', ok: true });
      es.onerror = () => cb({ kind: 'connection', ok: false });
      return () => es.close();
    },
  };
}
