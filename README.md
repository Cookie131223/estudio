# Estúdio de Agentes

Um painel no seu PC onde **Claude**, **ChatGPT (Codex)** e **Gemini** trabalham como um time.
Você faz um pedido, o coordenador divide em partes, cada IA faz a sua, e no fim vem uma resposta só.
Tudo roda nas **assinaturas que você já paga**: o app chama os programas oficiais (Claude Code, Codex CLI e Antigravity CLI), já logados. Nada de API cobrada por uso.

## Como rodar

1. Tenha o **Node.js** instalado (você já tem, porque os CLIs vieram pelo npm).
2. Dê dois cliques em **`Iniciar Estudio.bat`**. Abre uma janela preta (o servidor) e o Estúdio aparece no seu navegador em **http://localhost:4747**.
   **Deixe a janela preta aberta** enquanto usa; fechar ela fecha o Estúdio.
3. No Estúdio, vá em **Ajustes → Contas** e clique em **Testar login** nas três IAs.
4. Clique na pasta no topo e escolha a **pasta do projeto** onde o time vai trabalhar.
5. Escreva o pedido lá embaixo e aperte Enter.

O servidor só aceita conexões do seu próprio PC (localhost).
Existe também um modo janela com Electron (`npm install` e depois `npm run janela`), mas ele não é necessário.

### Se um CLI não estiver instalado

O jeito fácil é o botão **Instalar** em Ajustes → Contas. Ou à mão:
```
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
irm https://antigravity.google/cli/install.ps1 | iex      (no PowerShell)
```
Depois faça login uma vez em cada (`claude`, `codex login`, `agy`).
O Gemini roda pelo **Antigravity CLI** (`agy`): desde junho de 2026 o Gemini CLI não aceita mais contas pessoais do Google.

## Como funciona

- **Time**: o pedido vai para o coordenador (Regente, no Claude). Ele monta um plano em etapas.
  Tarefas da mesma etapa rodam **em paralelo**; cada etapa recebe o resultado das anteriores. No fim ele junta tudo.
  Se for só uma pergunta rápida, ele responde direto.
- **Falar com um agente só**: clique no nome dele na barra de baixo (ou no boneco no escritório).
- **Equipe fixa**: Traço (front) e Base (back) sempre entram juntos, cada um na sua parte. Dá para montar outras duplas e trios em Equipe → Editar.
- **Ao vivo**: cada passo aparece no painel da direita e no monitor da mesa do agente.

### Escritório 3D

Cada agente tem mesa, monitor, telefone e caneca. Quando você faz um pedido, todo mundo vai para a mesa de reunião enquanto o coordenador planeja.
Quem está trabalhando digita e o monitor mostra o que ele está fazendo. Se alguém precisa de aprovação, **o telefone da mesa toca**. No tempo livre, alguém vai tomar café.
Arraste para girar, role para aproximar.

### Níveis de autonomia (topo da tela, troca a qualquer momento)

| | Claude | Codex | Gemini (Antigravity) |
|---|---|---|---|
| **Perguntar tudo** | lê sozinho; editar, comandos e web tocam o telefone | só leitura | modo plano (só leitura) |
| **Aceitar edições** | edita arquivos da pasta sozinho; comandos e web tocam o telefone | edita dentro da pasta (sandbox) | aceita edições |
| **Sozinho** | tudo liberado, **menos o destrutivo** (rm -rf, git push --force, drop table…), que sempre pergunta | edita e roda comandos dentro da pasta, com internet | modo auto |

Mexer **fora da pasta do projeto** sempre pede aprovação no Claude.
O Codex e o Antigravity, no modo sem tela que o app usa, não conseguem pedir aprovação no meio da tarefa; por isso eles ficam presos ao sandbox/modo de cada nível.

### Botão Parar

Interrompe o time inteiro na hora (também com **Ctrl + .**). Pedidos de aprovação pendentes são cancelados.
O que já foi concluído fica na conversa, e os arquivos que já tinham sido salvos continuam na pasta.

### Dados

Tarefas por dia, por agente e por modelo, tokens (com % de cache) e tempo de trabalho.
O **Codex** informa o uso dos limites de 5 horas e semanal, e o app mostra isso. O Claude Code e o Antigravity não informam o limite da assinatura nesse modo; para o Claude o app mostra quanto custaria na API (não é cobrado).

### Por que nada é cobrado por uso

Antes de chamar os CLIs, o app **remove** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` e parecidas do ambiente. Assim cada CLI usa o login da assinatura.

## Versão online no Azure (conta de estudante)

1. Deixe este repositório público (Settings → Change visibility).
2. No portal do Azure, abra o **Cloud Shell** (ícone `>_` no topo), escolha **Bash** e cole:
   ```
   curl -fsSL https://raw.githubusercontent.com/Cookie131223/estudio/main/deploy/azure.sh | bash
   ```
3. Em uns 10 minutos o script mostra o **endereço** (`https://estudio-xxxxxx.<região>.cloudapp.azure.com`) e a **senha**.

O script cria um servidor Linux pequeno (B2ats v2 ou B1s, que entram nas 750 horas grátis da conta de estudante), instala Docker e Caddy (HTTPS automático) e roda o Estúdio com os dados em `/srv/estudio`. A cada 15 minutos ele confere o GitHub e se atualiza sozinho.

## Versão online (Railway)

A mesma interface roda num servidor, com senha, para acompanhar e aprovar o trabalho do time pelo celular.

- O `Dockerfile` instala o Claude Code, o Codex CLI e o Antigravity CLI. Variáveis: `ESTUDIO_PASSWORD` (senha de entrada). Volume em `/data` (logins, projetos e histórico).
- Contas no online (Ajustes → Contas):
  - **Claude:** rode `claude setup-token` no seu PC e cole o token.
  - **Codex:** envie o arquivo `C:\Users\(você)\.codex\auth.json`, ou entre com código.
  - **Gemini:** botão **Entrar** abre o login do Antigravity ali mesmo (link + código).
  - **GitHub:** token fine-grained com leitura e escrita em *Contents*, para clonar e dar push.
- Projetos ficam no servidor: crie um novo ou clone do GitHub pelo botão da pasta.
- No online, o Copiloto dá dicas, mas não controla mouse e teclado (isso só no PC).

## Arquivos

```
server.js    servidor local (modo navegador, o padrão)
main/        núcleo
  providers.js     adaptadores do Claude Code, Codex CLI e Antigravity CLI
  orchestrator.js  plano → etapas → integração, botão parar
  approvals.js     regras de autonomia e fila de aprovações
  approval-mcp.js  servidor MCP que o Claude Code chama para pedir aprovação
  store.js         dados salvos (agentes, histórico)
  core.js          liga tudo; usado pelo server.js e pelo modo janela
renderer/    interface (escritório 3D em three.js, equipe, dados, ajustes)
test/        testes com CLIs falsos: npm test (no WSL, Linux ou macOS)
```

Seus dados (agentes, histórico) ficam em `%USERPROFILE%\.estudio-agentes\dados\estudio.json`.


## Próximos passos possíveis

- Vozes por agente (ElevenLabs ou voz do Windows)
- Copiloto de tela (ver a tela e dar dicas, com controle de mouse/teclado opcional)
- Acompanhar e aprovar pelo celular
