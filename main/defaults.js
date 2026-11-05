// Time inicial. Tudo isso pode ser trocado na aba Equipe.
const TOOLS_ALL = { write: true, bash: true, web: true };

const DEFAULT_AGENTS = [
  {
    id: 'regente', name: 'Regente', role: 'Coordena, divide o pedido e junta as entregas',
    provider: 'claude', model: 'sonnet', effort: '', isLead: true,
    color: '#e8795a', body: 'caixa', eyes: 'pontos', antenna: true,
    team: [], tools: { ...TOOLS_ALL },
    spec: 'Você coordena o time. Pensa antes de agir, divide bem o trabalho e escreve respostas finais claras e curtas.',
  },
  {
    id: 'traco', name: 'Traço', role: 'Front-end, UX/UI e design',
    provider: 'claude', model: 'sonnet', effort: '',
    color: '#f2b84b', body: 'caixa', eyes: 'visor', antenna: false,
    team: ['base'], tools: { ...TOOLS_ALL },
    spec: 'Cuida de interface: HTML, CSS, componentes, acessibilidade e responsividade. Prefere soluções simples e bonitas.',
  },
  {
    id: 'base', name: 'Base', role: 'Back-end, infra e banco de dados',
    provider: 'claude', model: 'sonnet', effort: '',
    color: '#d9534f', body: 'caixa', eyes: 'sorriso', antenna: true,
    team: ['traco'], tools: { ...TOOLS_ALL },
    spec: 'Cuida de APIs, banco de dados, autenticação, deploy e scripts de servidor. Documenta variáveis de ambiente que criar.',
  },
  {
    id: 'farol', name: 'Farol', role: 'Pesquisa e documentação',
    provider: 'gemini', model: '', effort: '',
    color: '#6c8cff', body: 'orbe', eyes: 'pontos', antenna: false,
    team: [], tools: { ...TOOLS_ALL },
    spec: 'Pesquisa referências, documentação oficial e boas práticas. Sempre cita de onde tirou a informação.',
  },
  {
    id: 'lupa', name: 'Lupa', role: 'Revisão de código e testes',
    provider: 'codex', model: '', effort: 'medium',
    color: '#3fb6a8', body: 'gota', eyes: 'visor', antenna: true,
    team: [], tools: { ...TOOLS_ALL },
    spec: 'Revisa código procurando bugs, falhas de segurança e casos esquecidos. Roda os testes quando existirem e aponta o arquivo e a linha de cada problema.',
  },
  {
    id: 'prisma', name: 'Prisma', role: 'Textos, conteúdo e ideias',
    provider: 'gemini', model: '', effort: '',
    color: '#c56cf0', body: 'orbe', eyes: 'sorriso', antenna: true,
    team: [], tools: { ...TOOLS_ALL },
    spec: 'Escreve textos de interface, posts, descrições e ideias criativas. Tom direto, em português do Brasil.',
  },
];

const DEFAULT_SETTINGS = {
  studioName: 'COOKIE INTERPRISE',
  projectDir: '',
  autonomy: 'edits', // 'ask' | 'edits' | 'auto'
  sounds: true,
  voice: { enabled: false, engine: 'system', full: false }, // engine: 'system' (Windows) | 'eleven'
};

module.exports = { DEFAULT_AGENTS, DEFAULT_SETTINGS, TOOLS_ALL };
