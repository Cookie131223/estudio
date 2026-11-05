// Teste de ponta a ponta com CLIs falsos (test/fake-bin). Roda com: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PATH = path.join(__dirname, 'fake-bin') + path.delimiter + process.env.PATH;
const { Store } = require('../main/store');
const { Approvals, policy } = require('../main/approvals');
const { Orchestrator, parsePlan } = require('../main/orchestrator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(autonomy, { answer = 'allow', answerDelay = 30 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-'));
  const store = new Store(dir);
  store.setSettings({ projectDir: path.join(dir, 'Meu Projeto'), autonomy });
  const events = [];
  const asked = [];
  let orch;
  const approvals = new Approvals({
    getContext: (id) => orch.contextFor(id),
    onRequest: (req) => { orch.noteApproval(req.taskId); asked.push(req); events.push({ kind: 'approval', ...req }); if (answer) setTimeout(() => approvals.answer(req.id, answer), answerDelay); },
    onResolved: (r) => events.push({ kind: 'approvalResolved', ...r }),
    onAuto: (r) => events.push({ kind: 'auto', ...r }),
  });
  await approvals.start();
  orch = new Orchestrator({
    store, approvals, emit: (e) => events.push(e),
    mcp: { nodePath: process.execPath, scriptPath: path.join(__dirname, '..', 'main', 'approval-mcp.js') },
  });
  return { dir, store, approvals, orch, events, asked };
}

(async () => {
  // --- política de autonomia
  const cwd = path.resolve('/proj');
  assert.equal(policy('ask', 'Write', { file_path: 'a.txt' }, cwd).decision, 'ask');
  assert.equal(policy('edits', 'Write', { file_path: 'a.txt' }, cwd).decision, 'allow');
  assert.equal(policy('edits', 'Write', { file_path: '/etc/passwd' }, cwd).decision, 'ask');
  assert.equal(policy('edits', 'Bash', { command: 'npm test' }, cwd).decision, 'ask');
  assert.equal(policy('auto', 'Bash', { command: 'npm test' }, cwd).decision, 'allow');
  assert.equal(policy('auto', 'Bash', { command: 'rm -rf build' }, cwd).decision, 'ask');
  assert.equal(policy('auto', 'Bash', { command: 'git push --force origin main' }, cwd).decision, 'ask');
  assert.equal(policy('ask', 'Read', { file_path: 'x' }, cwd).decision, 'allow');
  console.log('ok  política de autonomia');

  // --- plano
  const agents = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }];
  assert.deepEqual(parsePlan('{"resposta":"oi"}', agents), { resposta: 'oi' });
  const p = parsePlan('blá ```json\n{"resumo":"x","etapas":[{"tarefas":[{"agente":"Beto","tarefa":"t1"},{"agente":"zz","tarefa":"t2"}]}]}\n```', agents);
  assert.equal(p.etapas[0].length, 1); assert.equal(p.etapas[0][0].agentId, 'b');
  assert.equal(parsePlan('sem json', agents), null);
  console.log('ok  leitura do plano');

  // --- fluxo completo do time, modo "aceitar edições"
  {
    const { store, orch, events, asked, approvals, dir } = await setup('edits');
    await orch.ask({ text: 'Cria uma landing page de turismo', target: 'team' });
    const msgs = store.data.messages;
    const plan = msgs.find((m) => m.role === 'plan');
    assert(plan, 'plano publicado');
    // Traço tem equipe fixa com Base: Base deve entrar junto na etapa 2
    assert.deepEqual(plan.steps.map((s) => s.map((t) => t.agentId)), [['farol'], ['traco', 'base'], ['lupa']]);
    const final = msgs[msgs.length - 1];
    assert.equal(final.role, 'agent'); assert.equal(final.agentId, 'regente');
    assert.match(final.text, /landing criada/);
    // Write liberado sozinho; npm test e rm -rf perguntados ao usuário (2 agentes Claude x 2 pedidos)
    assert.equal(asked.length, 4, 'perguntas: ' + asked.map((a) => a.tool + ' ' + a.command).join(', '));
    assert(asked.every((a) => a.tool === 'Bash'));
    assert(events.some((e) => e.kind === 'auto' && /Criando index.html/.test(e.summary)));
    assert(fs.existsSync(path.join(store.settings.projectDir, 'index.html')), 'arquivo criado na pasta do projeto (com espaço no nome)');
    const tasks = store.data.tasks;
    assert.equal(tasks.length, 6, 'plano + farol + traço + base + lupa + integração');
    assert(tasks.every((t) => t.ok), JSON.stringify(tasks.map((t) => [t.agentId, t.ok])));
    assert.equal(tasks.reduce((s, t) => s + t.approvals, 0), 4, 'aprovações contadas');
    assert.equal(tasks.find((t) => t.agentId === 'traco').files, 1, 'arquivo contado');
    const lupa = tasks.find((t) => t.agentId === 'lupa');
    assert.equal(lupa.input, 2000); assert.equal(lupa.cached, 1500);
    const farol = tasks.find((t) => t.agentId === 'farol');
    assert.equal(farol.output, 80);
    assert(store.data.limits.codex && store.data.limits.codex.data.primary.used_percent === 13, 'limite do Codex capturado');
    assert(events.some((e) => e.kind === 'agentState' && e.state === 'meeting'));
    assert(events.some((e) => e.kind === 'activity' && e.agentId === 'farol' && /hero com foto/.test(e.text)), 'texto do Gemini em streaming');
    const codexArgs = JSON.parse(fs.readFileSync(path.join(__dirname, '.last-codex-args'), 'utf8'));
    assert(codexArgs.includes('workspace-write') && codexArgs.includes('model_reasoning_effort=medium'));
    assert(!fs.existsSync(path.join(dir, 'mcp')) || fs.readdirSync(path.join(dir, 'mcp')).length === 0, 'configs MCP temporárias apagadas');
    const agyArgs = JSON.parse(fs.readFileSync(path.join(__dirname, '.last-agy-args'), 'utf8'));
    assert(agyArgs.includes('accept-edits') && agyArgs.includes('stream-json'), 'agy em modo aceitar edições');
    approvals.stop();
    console.log('ok  fluxo do time: plano → etapas → integração, aprovações e uso');
  }

  // --- resposta direta do coordenador + conversa com um agente
  {
    const { store, orch, approvals } = await setup('ask');
    await orch.ask({ text: 'oi tudo bem', target: 'team' });
    assert.equal(store.data.messages.at(-1).text, 'Tudo ótimo! Em que posso ajudar?');
    await orch.ask({ text: 'revisa o projeto', target: 'lupa' });
    assert.match(store.data.messages.at(-1).text, /lang/);
    const codexArgs = JSON.parse(fs.readFileSync(path.join(__dirname, '.last-codex-args'), 'utf8'));
    assert(codexArgs.includes('read-only'), 'modo perguntar tudo = Codex só leitura');
    approvals.stop();
    console.log('ok  resposta direta e conversa individual');
  }

  // --- negar aprovação
  {
    const { store, orch, approvals } = await setup('ask', { answer: 'deny' });
    await orch.ask({ text: 'faz algo', target: 'traco' });
    assert.match(store.data.messages.at(-1).text, /Write:deny, Bash:deny, Bash:deny/);
    assert(!fs.existsSync(path.join(store.settings.projectDir, 'index.html')));
    approvals.stop();
    console.log('ok  negar aprovação bloqueia a ação');
  }

  // --- botão Parar no meio (aprovação pendente + Codex lento)
  {
    process.env.FAKE_SLOW = '1';
    const { store, orch, events, approvals } = await setup('edits', { answer: null });
    const t0 = Date.now();
    const p = orch.ask({ text: 'Cria uma landing page de turismo', target: 'team' });
    // espera chegar uma aprovação pendente (telefone tocando)
    for (let i = 0; i < 100 && !events.some((e) => e.kind === 'approval'); i++) await sleep(50);
    assert(events.some((e) => e.kind === 'approval'), 'aprovação pendente');
    assert(orch.stop());
    await p;
    delete process.env.FAKE_SLOW;
    assert(Date.now() - t0 < 15000, 'parou rápido');
    assert(!orch.busy);
    assert.equal(approvals.pending.size, 0);
    const sys = store.data.messages.filter((m) => m.role === 'system').at(-1);
    assert.match(sys.text, /Time parado/);
    assert.match(sys.text, /Farol/, 'manteve o que já tinha sido concluído');
    assert(!store.data.messages.some((m) => m.role === 'agent'), 'sem resposta final depois de parar');
    approvals.stop();
    console.log('ok  parar interrompe tudo e mantém o que foi feito');
  }

  // --- Antigravity sem stream-json: cai para json
  {
    process.env.FAKE_AGY_NOSTREAM = '1';
    const { store, orch, approvals } = await setup('ask');
    await orch.ask({ text: 'pesquisa referências', target: 'farol' });
    delete process.env.FAKE_AGY_NOSTREAM;
    assert.match(store.data.messages.at(-1).text, /hero com foto grande/);
    const agyArgs = JSON.parse(fs.readFileSync(path.join(__dirname, '.last-agy-args'), 'utf8'));
    assert(agyArgs.includes('json') && agyArgs.includes('plan'), 'caiu para json, modo plan');
    assert.equal(store.data.tasks.at(-1).output, 70);
    approvals.stop();
    console.log('ok  Antigravity: troca de formato quando a versão não tem stream-json');
  }

  // --- copiloto: imagem direto, cai para arquivo quando a versão não aceita, e controle fora do Windows
  {
    const { createCopilot, keyToSendKeys } = require('../main/copilot');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cop-'));
    const store = new Store(dir);
    const sent = [];
    const cop = createCopilot({ dataDir: dir, send: (e) => sent.push(e), store });
    const img = 'data:image/jpeg;base64,' + Buffer.alloc(300, 7).toString('base64');
    let r = await cop.tip({ image: img, objective: 'salvar o arquivo', width: 1280, height: 720 });
    assert.equal(r.dica, 'Clique em Salvar no canto de cima.'); assert.equal(r.acao, null);
    r = await cop.tip({ image: img, objective: 'x', question: 'qual botão?', width: 1280, height: 720 });
    assert.match(r.dica, /botão azul/);
    // sem controle liberado, nenhuma ação volta mesmo se pedida
    r = await cop.tip({ image: img, objective: 'x', control: true, width: 1280, height: 720 });
    assert.equal(r.acao, null, 'ação só com controle liberado');
    const c = await cop.setControl(true);
    assert.equal(c.on, false); assert.match(c.error, /Windows/);
    assert.equal((await cop.act({ tipo: 'clicar', x: 1, y: 1 })).ok, false);
    process.env.FAKE_NO_IMAGE_INPUT = '1';
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cop2-'));
    const store2 = new Store(dir2);
    const cop2 = createCopilot({ dataDir: dir2, send: () => {}, store: store2 });
    r = await cop2.tip({ image: img, objective: 'x', width: 1280, height: 720 });
    delete process.env.FAKE_NO_IMAGE_INPUT;
    assert.equal(r.dica, 'Clique em Salvar no canto de cima.', 'modo arquivo');
    assert.equal(store2.settings.copilotImageMode, 'file');
    assert.equal(store.data.tasks.filter((t) => t.agentId === 'copiloto').length, 3, 'uso registrado');
    assert.equal(keyToSendKeys('ctrl+s'), '^s');
    console.log('ok  copiloto: dicas com imagem, pergunta, troca para arquivo, controle protegido');
  }

  console.log('\nTodos os testes passaram.');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
