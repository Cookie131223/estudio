#!/usr/bin/env bash
# Cria o servidor do Estúdio de Agentes no Azure.
# Rode no Cloud Shell (Bash) do portal: curl -fsSL https://raw.githubusercontent.com/Cookie131223/estudio/main/deploy/azure.sh | bash
set -uo pipefail

RG="${RG:-estudio-rg}"
NAME="estudio"
REPO="https://github.com/Cookie131223/estudio"
SIZES=(Standard_B2ats_v2 Standard_B1s)
REGIONS=(${REGIONS:-brazilsouth eastus eastus2 centralus southcentralus westus2 westus3 canadacentral northeurope westeurope})
PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 14)"
DNS="estudio-$(openssl rand -hex 3)"
TMP="$(mktemp -d)"

say() { printf '\n\033[1;31m▸\033[0m %s\n' "$*"; }

cloud_init() { # $1 = endereço (FQDN)
cat <<EOF
#cloud-config
package_update: true
packages:
  - docker.io
  - git
  - caddy
write_files:
  - path: /etc/estudio.env
    permissions: '0600'
    content: |
      ESTUDIO_PASSWORD=${PASS}
  - path: /etc/caddy/Caddyfile
    defer: true
    content: |
      $1 {
        encode gzip
        reverse_proxy 127.0.0.1:8080 {
          flush_interval -1
        }
      }
  - path: /usr/local/bin/estudio-update
    permissions: '0755'
    content: |
      #!/bin/bash
      # Baixa a versão nova do GitHub e reinicia o Estúdio (os dados ficam em /srv/estudio).
      set -e
      cd /opt/estudio
      git fetch -q origin main
      if [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/main)" ] || [ "\${1:-}" = "--force" ]; then
        git reset -q --hard origin/main
        docker build -q -t estudio .
        docker rm -f estudio >/dev/null 2>&1 || true
        docker run -d --name estudio --restart unless-stopped -p 127.0.0.1:8080:8080 -v /srv/estudio:/data --env-file /etc/estudio.env estudio
        docker image prune -f >/dev/null
        echo "\$(date) atualizado para \$(git rev-parse --short HEAD)"
      fi
  - path: /etc/cron.d/estudio-update
    content: |
      */15 * * * * root /usr/local/bin/estudio-update >> /var/log/estudio-update.log 2>&1
runcmd:
  - [bash, -c, "fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"]
  - [bash, -c, "git clone ${REPO} /opt/estudio"]
  - [bash, -c, "/usr/local/bin/estudio-update --force >> /var/log/estudio-update.log 2>&1"]
  - [systemctl, restart, caddy]
EOF
}

say "Criando o grupo de recursos $RG..."
RG_OK=0
for R in "${REGIONS[@]}"; do
  if az group create -n "$RG" -l "$R" -o none --only-show-errors 2>/dev/null; then RG_OK=1; break; fi
done
[ "$RG_OK" = 1 ] || { echo "Não consegui criar o grupo de recursos. Confira se a assinatura Azure for Students está ativa."; exit 1; }

OK=0
for R in "${REGIONS[@]}"; do
  FQDN="$DNS.$R.cloudapp.azure.com"
  cloud_init "$FQDN" > "$TMP/cloud-init.yaml"
  for S in "${SIZES[@]}"; do
    say "Tentando criar o servidor ($S) em $R..."
    if az vm create -g "$RG" -n "$NAME" -l "$R" \
        --image Canonical:ubuntu-24_04-lts:server:latest --size "$S" \
        --admin-username estudio --generate-ssh-keys \
        --public-ip-sku Standard --public-ip-address "$NAME-ip-$R" --public-ip-address-dns-name "$DNS" \
        --vnet-name "$NAME-vnet-$R" --nsg "$NAME-nsg-$R" \
        --os-disk-size-gb 32 --storage-sku StandardSSD_LRS \
        --custom-data "$TMP/cloud-init.yaml" -o none --only-show-errors; then
      OK=1; break 2
    fi
    # limpa o IP que sobrou da tentativa (IP fixo custa crédito)
    az network public-ip delete -g "$RG" -n "$NAME-ip-$R" -o none 2>/dev/null || true
  done
done
[ "$OK" = 1 ] || { echo "Nenhuma região aceitou o servidor. Me mande o erro acima."; exit 1; }

say "Abrindo as portas 80 e 443 (site com HTTPS)..."
az vm open-port -g "$RG" -n "$NAME" --port 80,443 --priority 900 -o none --only-show-errors

say "Servidor criado. Instalando o Estúdio lá dentro (leva uns 10 minutos)..."
URL="https://$FQDN"
for i in $(seq 1 60); do
  if curl -fsS -m 5 "$URL/api/ping" >/dev/null 2>&1; then break; fi
  printf '.'; sleep 20
done

cat <<EOF


==================================================================
  COOKIE INTERPRISE · Estúdio de Agentes no ar

  Endereço:  $URL
  Senha:     $PASS

  Guarde a senha agora (dá para trocar depois em Ajustes).
  O servidor se atualiza sozinho a cada 15 minutos com o GitHub.
==================================================================
EOF
curl -fsS -m 5 "$URL/api/ping" >/dev/null 2>&1 || echo "  Ainda instalando: se o endereço não abrir, espere mais 5 minutos e recarregue."
