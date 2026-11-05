const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('estudio', {
  getState: () => ipcRenderer.invoke('state:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  saveAgent: (a) => ipcRenderer.invoke('agent:save', a),
  deleteAgent: (id) => ipcRenderer.invoke('agent:delete', id),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  ask: (req) => ipcRenderer.invoke('ask', req),
  stop: () => ipcRenderer.invoke('stop'),
  answer: (id, decision) => ipcRenderer.invoke('approval:answer', id, decision),
  detect: () => ipcRenderer.invoke('providers:detect'),
  testProvider: (k) => ipcRenderer.invoke('providers:test', k),
  openLogin: (k) => ipcRenderer.invoke('providers:login', k),
  voice: (op, payload) => ipcRenderer.invoke('voice', op, payload),
  copilot: (op, payload) => ipcRenderer.invoke('copilot', op, payload),
  onEvent: (cb) => {
    const fn = (_e, ev) => cb(ev);
    ipcRenderer.on('estudio:event', fn);
    return () => ipcRenderer.removeListener('estudio:event', fn);
  },
});
