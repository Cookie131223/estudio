// Modo janela (opcional): o mesmo Estúdio dentro do Electron. Rode com "npm run janela".
// O modo padrão é o navegador (server.js), que não precisa do Electron.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, desktopCapturer } = require('electron');
const path = require('path');
const { createCore } = require('./core');

let win, core;
const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('estudio:event', ev); };

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: '#14110f',
    title: 'Estúdio de Agentes',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  core = await createCore({ dataDir: path.join(app.getPath('home'), '.estudio-agentes', 'dados'), send });
  ipcMain.handle('state:get', () => core.snapshot());
  ipcMain.handle('settings:set', (_e, patch) => core.store.setSettings(patch));
  ipcMain.handle('agent:save', (_e, a) => { const r = core.store.upsertAgent(a); send({ kind: 'agents', agents: core.store.agents }); return r; });
  ipcMain.handle('agent:delete', (_e, id) => { core.store.deleteAgent(id); send({ kind: 'agents', agents: core.store.agents }); return true; });
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pasta do projeto', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return core.setProjectDir(r.filePaths[0]);
  });
  ipcMain.handle('folder:open', () => core.openFolder());
  ipcMain.handle('ask', (_e, req) => { core.orch.ask(req); return true; });
  ipcMain.handle('stop', () => core.orch.stop());
  ipcMain.handle('approval:answer', (_e, id, decision) => core.approvals.answer(id, decision));
  ipcMain.handle('providers:detect', () => core.detectProviders());
  ipcMain.handle('providers:test', (_e, key) => core.testProvider(key));
  ipcMain.handle('providers:login', (_e, key) => core.openLogin(key));
  ipcMain.handle('voice', (_e, op, payload) => core.voice(op, payload || {}));
  ipcMain.handle('copilot', (_e, op, p) => (op === 'tip' ? core.copilot.tip(p || {}) : op === 'control' ? core.copilot.setControl(!!(p && p.on)) : op === 'act' ? core.copilot.act((p && p.acao) || {}) : core.copilot.status()));
  // Compartilhar tela no modo janela: usa a tela principal.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0] })).catch(() => cb({}));
  });
  createWindow();
});

app.on('before-quit', () => { core && core.shutdown(); });
app.on('window-all-closed', () => app.quit());
