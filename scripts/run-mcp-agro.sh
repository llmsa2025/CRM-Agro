#!/bin/bash
# Servidor MCP do verificador de agro (stdio). Quem sobe é o cliente MCP (Claude Code, por exemplo), não o pm2.
# O protocolo MCP anda no stdout, e o logger do core também escreve nele. Por isso o stdout original é guardado no
# descritor 3 e o 1 passa a apontar para o stderr: o servidor fala com o cliente pelo 3.
# Precisa de CRMAGRO_AGRO_TEAM_ID no .env (o id do time que o servidor atende).
set -euo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE:-$RAIZ/.env}"
set +a
export NODE_ENV=production
export CRMAGRO_MCP_DESCRITOR_3=1
exec 3>&1 1>&2
cd "$RAIZ/apps/mcp-agro"
exec node --import tsx src/index.ts
