// Partes da interface que só aparecem na versão online (Railway).
import { esc } from './md.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function openModal(inner, cls = 'dialog one') {
  const modal = $('#modal');
  modal.innerHTML = '';
  const d = h(`<div class="${cls}" role="dialog">${inner}</div>`);
  modal.append(d);
  modal.hidden = false;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  modal.onclick = (e) => { if (e.target === modal) close(); };
  return { d, close };
}

/* -------------------------------- projetos -------------------------------- */
export async function openProjectPicker({ api, toast, onPicked }) {
  const { d, close } = openModal(`
    <div class="right">
      <div><h1>Projetos</h1><p class="sub">No online, os projetos ficam no servidor. Crie um novo ou traga um do seu GitHub.</p></div>
      <div class="plist" id="plist"><div class="note">Carregando…</div></div>
      <div class="field"><span>Trazer do GitHub</span><div class="keybox"><input class="input" id="pUrl" placeholder="https://github.com/Cookie131223/gestao-pro"><button class="btn sm primary" id="pClone">Clonar</button></div><div class="note">Repositório privado? Conecte o GitHub em Ajustes → Contas antes.</div></div>
      <div class="field"><span>Projeto novo</span><div class="keybox"><input class="input" id="pName" placeholder="nome-do-projeto" maxlength="60"><button class="btn sm" id="pNew">Criar</button></div></div>
      <div class="foot"><span class="spacer"></span><button class="btn" id="pClose">Fechar</button></div>
    </div>`);
  $('#pClose', d).onclick = close;
  const load = async () => {
    const r = await api.online('projects');
    $('#plist', d).innerHTML = r.list.length
      ? r.list.map((p) => `<button class="prow ${p.current ? 'on' : ''}" data-p="${esc(p.path)}"><b>${esc(p.name)}</b><span>${p.git ? 'GitHub' : 'local'}${p.current ? ' · em uso' : ''}</span></button>`).join('')
      : '<div class="note">Nenhum projeto ainda.</div>';
    $$('[data-p]', d).forEach((b) => {
      b.onclick = async () => {
        const s = await api.setFolder(b.dataset.p);
        if (s) { onPicked(s); toast(`Projeto: ${b.querySelector('b').textContent}`); close(); }
      };
    });
  };
  $('#pNew', d).onclick = async () => {
    const r = await api.online('projectNew', { name: $('#pName', d).value });
    if (r.error) return toast(r.error, true);
    onPicked(r.path); toast('Projeto criado.'); close();
  };
  $('#pClone', d).onclick = async () => {
    const btn = $('#pClone', d);
    btn.disabled = true; btn.textContent = 'Clonando…';
    const r = await api.online('projectClone', { url: $('#pUrl', d).value });
    btn.disabled = false; btn.textContent = 'Clonar';
    if (r.error) return toast(r.error, true);
    onPicked(r.path); toast(r.existed ? 'Esse projeto já estava aqui. Selecionado.' : 'Projeto clonado.'); close();
  };
  load();
}

/* --------------------------------- contas --------------------------------- */
export function onlineAccountsHtml(S, PROV) {
  const A = S.accounts || {};
  const P = S.providers || {};
  const tag = (ok, label = '✓ Conectado') => (ok ? `<span class="tag ok">${label}</span>` : '<span class="tag bad">Falta conectar</span>');
  const row = (k, title, ok, desc, btns) => `<div class="row"><div class="info"><b>${esc(title)} ${tag(ok)}</b><div>${desc}</div>${P[k] && P[k].loginOk === false ? `<div style="color:#ff9a8a">${esc(P[k].loginMsg || '')}</div>` : ''}</div>${btns}</div>`;
  const test = (k) => `<button class="btn sm" data-test="${k}">Testar login</button>`;
  return `
    <p class="sub" style="max-width:900px;margin-bottom:12px">No online, cada IA roda no servidor com o login da sua assinatura. Os logins ficam guardados só no seu servidor do Railway.</p>
    <div class="acc">
      ${row('claude', PROV.claude.label, A.claude, 'No seu PC, abra o terminal e rode <code class="kbd">claude setup-token</code>. Ele abre o navegador, você confirma, e aparece um token começando com <code class="kbd">sk-ant-oat</code>. Cole aqui.',
        `${test('claude')}<button class="btn sm primary" data-acc="claude">${A.claude ? 'Trocar token' : 'Colar token'}</button>`)}
      ${row('codex', PROV.codex.label, A.codex, 'Envie o arquivo de login do seu PC: <code class="kbd">C:\\Users\\(você)\\.codex\\auth.json</code>. Ou entre pelo terminal com um código.',
        `${test('codex')}<button class="btn sm" data-term="codex">Entrar com código</button><button class="btn sm primary" data-acc="codex">Enviar auth.json</button>`)}
      ${row('gemini', PROV.gemini.label, P.gemini && P.gemini.loginOk, 'Abre o login do Antigravity aqui mesmo: você abre o link, entra com a conta Google e cola o código de volta.',
        `${test('gemini')}<button class="btn sm primary" data-term="gemini">Entrar</button>`)}
      ${row('github', 'GitHub', A.github, `${A.githubUser ? `Conta <b>${esc(A.githubUser)}</b>. ` : ''}Para o time clonar seus repositórios e enviar as mudanças (git push). Crie um token em github.com → Settings → Developer settings → Fine-grained tokens, com acesso de leitura e escrita em <b>Contents</b>.`,
        `<button class="btn sm primary" data-acc="github">${A.github ? 'Trocar token' : 'Colar token'}</button>`)}
    </div>`;
}

export function bindOnlineAccounts({ api, toast, refresh }) {
  $$('[data-acc]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.acc;
      const isFile = key === 'codex';
      const title = { claude: 'Token do Claude', codex: 'Login do Codex (auth.json)', github: 'Token do GitHub' }[key];
      const { d, close } = openModal(`<div class="right">
        <div><h1>${title}</h1><p class="sub">${isFile ? 'Escolha o arquivo auth.json da pasta .codex do seu PC.' : 'Cole o token abaixo. Ele fica guardado só no seu servidor.'}</p></div>
        ${isFile ? '<input type="file" id="accFile" accept=".json,application/json" class="input">' : '<input class="input" id="accVal" type="password" autocomplete="off" placeholder="cole aqui">'}
        <div class="foot"><button class="btn danger" id="accDel">Remover</button><span class="spacer"></span><button class="btn" id="accCancel">Cancelar</button><button class="btn primary" id="accSave">Salvar</button></div></div>`);
      $('#accCancel', d).onclick = close;
      $('#accDel', d).onclick = async () => { await api.online('account', { key, value: '' }); close(); toast('Removido.'); refresh(); };
      $('#accSave', d).onclick = async () => {
        let value = '';
        if (isFile) {
          const f = $('#accFile', d).files[0];
          if (!f) return toast('Escolha o arquivo.', true);
          value = await f.text();
        } else value = $('#accVal', d).value;
        const r = await api.online('account', { key, value });
        if (r.error) return toast(r.error, true);
        close();
        toast(r.user ? `GitHub conectado: ${r.user}.` : 'Salvo. Agora clique em "Testar login".');
        refresh();
      };
    };
  });
  $$('[data-term]').forEach((b) => { b.onclick = () => openTerminal({ api, toast, key: b.dataset.term, refresh }); });
}

/* ---------------------------- terminal de login --------------------------- */
let termBox = null;
export function openTerminal({ api, toast, key, refresh }) {
  const title = { gemini: 'Login do Antigravity (Gemini)', codex: 'Login do Codex com código' }[key];
  const { d, close } = openModal(`<div class="right">
    <div><h1>${title}</h1><p class="sub">Abra o link que aparecer, entre com a sua conta, copie o código e cole no campo de baixo. Se aparecer um menu, use as setas e Enter.</p></div>
    <pre class="term" id="termOut">Abrindo…\n</pre>
    <div class="keybox"><input class="input" id="termIn" placeholder="cole o código aqui" autocomplete="off"><button class="btn sm primary" id="termSend">Enviar</button></div>
    <div class="term-keys"><button class="btn sm" data-k="up">↑</button><button class="btn sm" data-k="down">↓</button><button class="btn sm" data-k="enter">Enter</button><button class="btn sm" data-k="esc">Esc</button></div>
    <div class="foot"><span class="spacer"></span><button class="btn" id="termClose">Fechar</button></div></div>`);
  termBox = $('#termOut', d);
  const sendIn = () => { const v = $('#termIn', d).value; $('#termIn', d).value = ''; api.online('termInput', { text: v }); };
  $('#termSend', d).onclick = sendIn;
  $('#termIn', d).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendIn(); } });
  $$('[data-k]', d).forEach((b) => { b.onclick = () => api.online('termInput', { keyName: b.dataset.k }); });
  $('#termClose', d).onclick = () => { api.online('termStop'); termBox = null; close(); refresh(); };
  api.online('termStart', { key }).then((r) => { if (r.error) toast(r.error, true); });
}

export function handleTermEvent(ev) {
  if (!termBox) return;
  if (ev.text) {
    termBox.textContent = (termBox.textContent + ev.text).slice(-15000);
    // links clicáveis
    termBox.innerHTML = esc(termBox.textContent).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
    termBox.scrollTop = termBox.scrollHeight;
  }
  if (ev.done) termBox.insertAdjacentHTML('beforeend', `\n<b>[terminou${ev.code ? ` com código ${ev.code}` : ''}. Clique em Fechar e depois em "Testar login".]</b>\n`);
}

/* ------------------------------ senha e sair ------------------------------ */
export function onlineSecurityHtml() {
  return `<h2>Acesso</h2>
    <div class="form">
      <label class="field"><span>Senha atual</span><input class="input" id="pwCur" type="password" autocomplete="current-password"></label>
      <label class="field"><span>Nova senha (mínimo 8 caracteres)</span><div class="keybox" style="margin:0"><input class="input" id="pwNew" type="password" autocomplete="new-password"><button class="btn sm" id="pwSave">Trocar</button></div></label>
    </div>
    <div style="margin-top:12px"><button class="btn danger sm" id="logout">Sair deste aparelho</button></div>`;
}
export function bindOnlineSecurity({ api, toast }) {
  const save = $('#pwSave');
  if (!save) return;
  save.onclick = async () => {
    const r = await api.online('password', { current: $('#pwCur').value, next: $('#pwNew').value });
    if (r.error) return toast(r.error, true);
    toast('Senha trocada. Entre de novo.');
    setTimeout(() => { location.href = '/login'; }, 1200);
  };
  $('#logout').onclick = async () => { await api.online('logout'); location.href = '/login'; };
}
