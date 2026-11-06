#!/bin/bash
# Sobe o servidor web (Next.js + Socket.IO) em modo produção, lendo o .env da raiz.
# Use depois de `pnpm --filter @crmagro/web build`. Em servidor, deixe o pm2 chamar este script
# (ecosystem.config.cjs). Variáveis opcionais: WEB_PORT (padrão 3001), WEB_BIND (padrão 127.0.0.1), ENV_FILE.
#
# O script termina em `exec node ...`: o bash vira o node (mesmo pid), então o pm2 mede a memória do
# processo certo e o sinal de parada chega direto nele.
set -euo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE:-$RAIZ/.env}"
set +a
export NODE_ENV=production
# O Socket.IO só sobe no custom server (server.ts); com `next start` o inbox cai para polling.
# Atrás de proxy (Caddy, Nginx) deixe em 127.0.0.1. Para expor direto, use WEB_BIND=0.0.0.0.
export HOSTNAME="${WEB_BIND:-127.0.0.1}"
export PORT="${WEB_PORT:-3001}"
cd "$RAIZ/apps/web"
exec node --import tsx server.ts
