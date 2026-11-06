#!/bin/bash
# Sobe o worker (motor de fluxos, filas BullMQ, captação, envio) em modo produção, lendo o .env da raiz.
# O worker precisa de um processo vivo: NÃO roda em serverless (Vercel). Use pm2, systemd ou um container.
# Variáveis opcionais: ENV_FILE, WORKER_PRIMARY (true no processo único; ao escalar, só um deve ser "true").
set -euo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE:-$RAIZ/.env}"
set +a
export NODE_ENV=production
# Pool de conexões próprio do worker (maior que o do web), se você definiu DATABASE_URL_WORKER.
if [ -n "${DATABASE_URL_WORKER:-}" ]; then
  export DATABASE_URL="$DATABASE_URL_WORKER"
fi
cd "$RAIZ/apps/worker"
exec node --import tsx src/index.ts
