// Aba "Copiloto": compartilha a tela, manda uma imagem quando ela muda e mostra as dicas
// em texto, em voz e numa janelinha por cima de tudo. Com permissão, executa ações.
import { esc } from './md.js';

const CTRL_MS = 10 * 60 * 1000;

export function initCopilot({ root, api, voice, toast }) {
  let stream = null;
  let video = null;
  let timer = null;
  let busy = false;
  let lastSig = null;
  let pendingQuestion = '';
  let tips = [];
  let control = false;
  let controlUntil = 0;
  let countdown = null;
  let pip = null;
  let surface = '';
  const LS = 'estudio.copiloto';
  let prefs = { objective: '', model: 'equilibrio', every: 8, speak: true };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch {}
  const savePrefs = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch {} };

  root.innerHTML = `
    <div class="page-head"><div><h1>Copiloto de tela</h1><p>O Claude vê o que você está vendo e dá dicas ao vivo: o que fazer, o que evitar. Se você liberar, ele também clica e digita por você.</p></div></div>
    <div class="cp-grid">
      <div class="tile cp-screen">
        <div class="cp-video"><video id="cpVideo" muted playsinline></video>
          <div class="cp-empty" id="cpEmpty"><b>Nenhuma tela compartilhada</b><span>Escolha a tela inteira, uma janela (um jogo, o VS Code) ou uma aba.</span><button class="btn primary" id="cpShare">Escolher o que compartilhar</button></div>
          <div class="cp-live" id="cpLive" hidden><i></i><span id="cpLiveTxt">Olhando</span></div>
        </div>
        <label class="field"><span>Seu objetivo</span><input class="input" id="cpObjective" maxlength="300" placeholder="Ex.: passar da fase 3 sem morrer · configurar o deploy na Vercel · entender esse erro"></label>
        <div class="cp-ask"><input class="input" id="cpQuestion" maxlength="300" placeholder="Pergunte algo sobre o que está na tela agora…"><button class="btn sm" id="cpAsk">Perguntar</button></div>
        <div class="cp-actions"><button class="btn primary" id="cpStart">Começar</button><button class="btn" id="cpStop" disabled>Parar</button><button class="btn" id="cpPip" title="Uma janelinha que fica por cima de todos os programas">Dicas por cima de tudo</button><button class="btn danger" id="cpUnshare" hidden>Parar de compartilhar</button></div>
      </div>
      <div class="cp-side">
        <div class="tile">
          <div class="grow">
            <label class="field"><span>Modelo</span><select class="input" id="cpModel"><option value="rapido">Haiku · mais rápido</option><option value="equilibrio">Sonnet · equilíbrio</option><option value="esperto">Opus · mais esperto (gasta mais)</option></select></label>
            <label class="field"><span>Olhar a tela a cada <b id="cpEveryTxt"></b></span><input type="range" id="cpEvery" min="4" max="30" step="1"></label>
          </div>
          <div class="note" style="margin-top:8px">Só manda imagem quando a tela muda. Cada olhada usa o limite da sua assinatura do Claude.</div>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="cpSpeak"> Falar as dicas em voz alta</label>
        </div>
        <div class="tile cp-control" id="cpControlBox">
          <div class="cp-ctrl-head"><b>Mouse e teclado</b><label class="check"><input type="checkbox" id="cpControl"> Deixar o copiloto usar</label></div>
          <div class="note" id="cpControlNote">Com isso ligado, ele faz uma ação por vez (clicar, digitar, apertar uma tecla, rolar). <b>F12</b> devolve o controle na hora, e a permissão acaba sozinha em 10 minutos. Ele nunca digita senhas nem confirma compras, pagamentos ou envios.</div>
          <div class="cp-timer" id="cpTimer" hidden></div>
        </div>
        <div class="tile cp-tips"><small>Dicas</small><div id="cpTips"><div class="note">As dicas aparecem aqui.</div></div></div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  video = $('#cpVideo');
  $('#cpObjective').value = prefs.objective;
  $('#cpModel').value = prefs.model;
  $('#cpEvery').value = prefs.every;
  $('#cpEveryTxt').textContent = `${prefs.every} s`;
  $('#cpSpeak').checked = prefs.speak;
  $('#cpObjective').oninput = (e) => { prefs.objective = e.target.value; savePrefs(); };
  $('#cpModel').onchange = (e) => { prefs.model = e.target.value; savePrefs(); };
  $('#cpEvery').oninput = (e) => { prefs.every = Number(e.target.value); $('#cpEveryTxt').textContent = `${prefs.every} s`; savePrefs(); if (timer) { stopLoop(); startLoop(); } };
  $('#cpSpeak').onchange = (e) => { prefs.speak = e.target.checked; savePrefs(); if (!prefs.speak) voice.stop(); };

  /* ---------------------------- compartilhar ---------------------------- */
  async function share() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Este navegador não deixa compartilhar a tela. Use o Chrome ou o Edge no computador.', true); return false; }
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    } catch { return false; }
    const track = stream.getVideoTracks()[0];
    surface = (track.getSettings && track.getSettings().displaySurface) || '';
    track.addEventListener('ended', unshare);
    video.srcObject = stream;
    await video.play().catch(() => {});
    $('#cpEmpty').hidden = true;
    $('#cpUnshare').hidden = false;
    lastSig = null;
    updateControlAvailability();
    return true;
  }
  function unshare() {
    stopLoop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; surface = '';
    video.srcObject = null;
    $('#cpEmpty').hidden = false;
    $('#cpUnshare').hidden = true;
    if (control) setControl(false);
    updateControlAvailability();
  }
  $('#cpShare').onclick = share;
  $('#cpUnshare').onclick = unshare;

  /* ------------------------------- captura ------------------------------ */
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = 48; sigCanvas.height = 27;
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
  const shot = document.createElement('canvas');

  // Com o navegador em segundo plano (você no jogo), o <video> pode parar de atualizar.
  // O ImageCapture pega o quadro direto da captura.
  let grabber = null;
  async function frame() {
    const track = stream && stream.getVideoTracks()[0];
    if (track && 'ImageCapture' in window) {
      try {
        if (!grabber || grabber.track !== track) grabber = new ImageCapture(track);
        const bmp = await grabber.grabFrame();
        return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
      } catch {}
    }
    return { src: video, w: video.videoWidth, h: video.videoHeight, close: () => {} };
  }

  function signature(f) {
    sigCtx.drawImage(f.src, 0, 0, 48, 27);
    const d = sigCtx.getImageData(0, 0, 48, 27).data;
    const g = new Uint8Array(48 * 27);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return g;
  }
  function changed(sig) {
    if (!lastSig) return true;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff += Math.abs(sig[i] - lastSig[i]);
    return diff / sig.length > 3;
  }
  function capture(f) {
    const vw = f.w, vh = f.h;
    const scale = Math.min(1, 1280 / vw);
    shot.width = Math.round(vw * scale); shot.height = Math.round(vh * scale);
    shot.getContext('2d').drawImage(f.src, 0, 0, shot.width, shot.height);
    return { image: shot.toDataURL('image/jpeg', 0.72), width: shot.width, height: shot.height, vw, vh };
  }

  function live(txt, on = true) {
    $('#cpLive').hidden = !on;
    $('#cpLiveTxt').textContent = txt;
  }

  async function cycle(force = false) {
    if (busy || !stream) return;
    busy = true;
    const f = await frame();
    if (!f.w) { busy = false; f.close(); return; }
    const sig = signature(f);
    const q = pendingQuestion;
    if (!force && !q && !changed(sig)) { busy = false; f.close(); live('Tela parada · sem gastar'); return; }
    lastSig = sig;
    pendingQuestion = '';
    live(q ? 'Pensando na sua pergunta…' : 'Olhando a tela…');
    const cap = capture(f);
    f.close();
    let r;
    try {
      r = await api.copilot('tip', {
        image: cap.image, width: cap.width, height: cap.height,
        objective: prefs.objective, question: q, model: prefs.model,
        history: tips.slice(0, 5).map((t) => t.text).reverse(),
        control: control && controlUntil > Date.now(),
      });
    } catch (e) { r = { error: e.message }; }
    busy = false;
    if (!timer && !force) return;
    if (r.error) { live('Erro'); addTip({ text: r.error, kind: 'error' }); return; }
    live(`Olhando a cada ${prefs.every} s`);
    if (r.dica && (r.nova || q)) {
      addTip({ text: r.dica, kind: q ? 'answer' : 'tip', q });
      if (prefs.speak) voice.speak('copiloto', r.dica, { force: true, full: true });
    }
    if (r.acao && control) await doAction(r.acao, cap);
  }

  // Relógio num Web Worker: o navegador não desacelera tanto quando a aba fica em segundo plano.
  let ticker = null;
  try {
    ticker = new Worker(URL.createObjectURL(new Blob(['let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(1),e.data)}'], { type: 'text/javascript' })));
    ticker.onmessage = () => { if (timer) cycle(false); };
  } catch { ticker = null; }

  function startLoop() {
    if (timer) return;
    if (ticker) { ticker.postMessage(prefs.every * 1000); timer = true; }
    else timer = setInterval(() => cycle(false), prefs.every * 1000);
    $('#cpStart').disabled = true; $('#cpStop').disabled = false;
    live(`Olhando a cada ${prefs.every} s`);
    cycle(true);
  }
  function stopLoop() {
    if (ticker) ticker.postMessage(0);
    if (timer !== true) clearInterval(timer);
    timer = null;
    $('#cpStart').disabled = false; $('#cpStop').disabled = true;
    live('', false);
  }
  $('#cpStart').onclick = async () => {
    if (!stream && !(await share())) return;
    if (!prefs.objective.trim()) toast('Dica: escreva o seu objetivo para as dicas ficarem certeiras.');
    startLoop();
  };
  $('#cpStop').onclick = () => { stopLoop(); voice.stop(); };
  const ask = async () => {
    const q = $('#cpQuestion').value.trim();
    if (!q) return;
    if (!stream && !(await share())) return;
    pendingQuestion = q;
    $('#cpQuestion').value = '';
    addTip({ text: q, kind: 'question' });
    if (!busy) cycle(true);
  };
  $('#cpAsk').onclick = ask;
  $('#cpQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });

  /* -------------------------------- dicas ------------------------------- */
  function addTip(t) {
    t.at = new Date();
    tips.unshift(t);
    tips = tips.slice(0, 40);
    const el = $('#cpTips');
    el.innerHTML = tips.map((x) => `<div class="cp-tip ${x.kind}"><span class="t">${x.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>${x.kind === 'question' ? '<b>Você:</b> ' : x.kind === 'action' ? '<b>Ação:</b> ' : ''}${esc(x.text)}</div>`).join('');
    if (t.kind === 'tip' || t.kind === 'answer' || t.kind === 'error') updatePip(t);
  }

  /* ------------------------ janela por cima de tudo ---------------------- */
  function updatePip(t) {
    if (!pip || pip.closed) return;
    const box = pip.document.getElementById('tip');
    if (box) { box.textContent = t.text; box.className = t.kind; }
  }
  $('#cpPip').onclick = async () => {
    const dpp = window.documentPictureInPicture;
    if (!dpp) { toast('Seu navegador não tem janela flutuante. Use o Chrome ou o Edge atualizados.', true); return; }
    try {
      pip = await dpp.requestWindow({ width: 380, height: 170 });
      pip.document.body.innerHTML = `<style>
        body{margin:0;background:#121214;color:#f3f3f4;font:15px/1.45 "Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;height:100vh}
        header{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #2a2a2f;font-size:12px;color:#9c9ca6;font-weight:600}
        header i{width:8px;height:8px;border-radius:50%;background:#5fd08a}
        #tip{padding:10px 12px;flex:1;overflow:auto}
        #tip.error{color:#ff9a8a}
      </style><header><i></i>Copiloto do Estúdio</header><div id="tip">${esc(tips.find((x) => x.kind !== 'question')?.text || 'As dicas aparecem aqui, por cima de tudo.')}</div>`;
    } catch (e) { toast('Não consegui abrir a janela flutuante.', true); }
  };

  /* ---------------------------- mouse e teclado -------------------------- */
  function updateControlAvailability() {
    const box = $('#cpControl');
    const fullScreen = !stream || surface === 'monitor' || surface === '';
    box.disabled = !!stream && !fullScreen;
    $('#cpControlNote').innerHTML = box.disabled
      ? 'Para ele usar o mouse e o teclado, compartilhe a <b>tela inteira</b> (não uma janela ou aba). Assim ele sabe onde clicar.'
      : 'Com isso ligado, ele faz uma ação por vez (clicar, digitar, apertar uma tecla, rolar). <b>F12</b> devolve o controle na hora, e a permissão acaba sozinha em 10 minutos. Ele nunca digita senhas nem confirma compras, pagamentos ou envios. Funciona na tela principal.';
  }

  async function setControl(on) {
    const box = $('#cpControl');
    if (!on) {
      control = false; controlUntil = 0; box.checked = false;
      clearInterval(countdown); $('#cpTimer').hidden = true;
      await api.copilot('control', { on: false }).catch(() => {});
      return;
    }
    const r = await api.copilot('control', { on: true }).catch((e) => ({ error: e.message }));
    if (!r || !r.on) { box.checked = false; toast((r && r.error) || 'Não consegui liberar o controle.', true); return; }
    control = true; controlUntil = Date.now() + CTRL_MS; box.checked = true;
    $('#cpTimer').hidden = false;
    clearInterval(countdown);
    const tick = () => {
      const left = Math.max(0, controlUntil - Date.now());
      $('#cpTimer').innerHTML = `<b>Controle liberado</b> · acaba em ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} · <b>F12</b> devolve`;
      if (!left) setControl(false);
    };
    tick();
    countdown = setInterval(tick, 1000);
    toast('Controle liberado por 10 minutos. Aperte F12 a qualquer momento para retomar.');
  }
  $('#cpControl').onchange = (e) => setControl(e.target.checked);

  function describe(a) {
    if (a.tipo === 'clicar') return `${a.duplo ? 'clique duplo' : a.botao === 'direito' ? 'clique direito' : 'clique'} em (${Math.round(a.x)}, ${Math.round(a.y)})`;
    if (a.tipo === 'digitar') return `digitar "${String(a.texto).slice(0, 60)}"`;
    if (a.tipo === 'tecla') return `tecla ${a.tecla}`;
    if (a.tipo === 'rolar') return `rolar ${a.quanto > 0 ? 'para cima' : 'para baixo'}`;
    return a.tipo;
  }
  async function doAction(a, cap) {
    if (!(controlUntil > Date.now())) return;
    const real = { ...a };
    if (a.tipo === 'clicar') {
      // da imagem enviada para os pixels reais da tela
      real.x = (Number(a.x) * cap.vw) / cap.width;
      real.y = (Number(a.y) * cap.vh) / cap.height;
    }
    addTip({ text: describe(a), kind: 'action' });
    const r = await api.copilot('act', { acao: real }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) {
      addTip({ text: r.error || 'A ação falhou.', kind: 'error' });
      if (/F12|não está liberado/i.test(r.error || '')) setControl(false);
    }
    lastSig = null; // depois de agir, olha de novo
  }

  return {
    onEvent(ev) {
      if (ev.kind === 'copilot' && ev.control === false) {
        if (control) {
          setControl(false);
          toast(ev.reason === 'F12' ? 'F12: você retomou o controle.' : ev.reason === 'tempo' ? 'Os 10 minutos acabaram: o controle voltou para você.' : 'O controle voltou para você.');
          addTip({ text: ev.reason === 'F12' ? 'Você apertou F12 e retomou o controle.' : 'Controle devolvido.', kind: 'action' });
        }
      }
    },
    get active() { return !!timer; },
  };
}
