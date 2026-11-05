# Estúdio de Agentes, versão online (Railway).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates bsdutils procps \
 && rm -rf /var/lib/apt/lists/*

# CLIs oficiais: Claude Code e Codex.
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# Antigravity CLI (Gemini). Se o instalador falhar, o resto do Estúdio continua funcionando.
RUN (curl -fsSL https://antigravity.google/cli/install.sh | bash) || echo "Antigravity CLI nao instalado"; \
    AGY="$(find /root /usr/local -name agy -type f -perm -u+x 2>/dev/null | head -1)"; \
    if [ -n "$AGY" ] && [ "$AGY" != "/usr/local/bin/agy" ]; then ln -sf "$AGY" /usr/local/bin/agy; fi; true

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV ESTUDIO_ONLINE=1 \
    ESTUDIO_DATA=/data \
    NODE_ENV=production

EXPOSE 8080
CMD ["node", "server.js"]
