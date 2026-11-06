# Deploy na Vercel (web) com worker em outro lugar

A Vercel hospeda só o **site** (Next.js). O **worker** é um processo contínuo e não roda em serverless: ele precisa de uma máquina viva (um VPS barato, Railway, Render, Fly). Banco e Redis precisam ser serviços acessíveis pela internet.

O que muda em relação ao VPS: na Vercel não existe o servidor próprio (`server.ts`), então o **Socket.IO fica desligado** e o inbox atualiza por polling. O resto funciona igual.

## O que você precisa criar antes

| Peça | Opções | Observação |
|---|---|---|
| PostgreSQL | Supabase, Neon, Railway | Pegue duas URLs: a **do pooler** (para o app) e a **direta** (para as migrations) |
| Redis | Upstash, Redis Cloud, Railway | Use a URL com TLS (`rediss://...`) |
| Máquina do worker | VPS, Railway, Render, Fly | Precisa ficar ligada 24 h |
| Evolution API (WhatsApp, opcional) | VPS, Railway | Precisa ser alcançável pelo worker e chamar o webhook do site |

## 1. Banco: rodar as migrations

Do seu computador (ou do CI), apontando para o banco gerenciado:

```bash
git clone https://github.com/llmsa2025/CRM-Agro.git && cd CRM-Agro
pnpm install
DATABASE_URL="<url direta>" DIRECT_URL="<url direta>" pnpm --filter @crmagro/db exec prisma migrate deploy
```

Não rode o seed de demonstração em banco de produção: o usuário demo é dono do time e a senha padrão é pública.

Crie o seu usuário:

```bash
printf 'UmaSenhaForte123\nUmaSenhaForte123\n' | DATABASE_URL="<url direta>" DIRECT_URL="<url direta>" pnpm db:create-user voce@empresa.com "Seu Nome" --novo-time "Minha Empresa"
```

## 2. Projeto na Vercel

1. **Add New > Project** e importe o repositório.
2. **Root Directory:** `apps/web`. Em **Settings > General**, deixe ligado **Include source files outside of the Root Directory in the Build Step** (o web importa os pacotes de `packages/`).
3. Framework: Next.js (a detecção é automática). O `apps/web/vercel.json` já define `pnpm install --frozen-lockfile` e `pnpm run build`.
4. **Environment Variables** (Production):

| Variável | Valor |
|---|---|
| `DATABASE_URL` | URL do **pooler** (ex.: `...?pgbouncer=true&connection_limit=5`) |
| `DIRECT_URL` | URL direta |
| `REDIS_URL` | `rediss://...` do Redis gerenciado |
| `AUTH_SECRET` | `openssl rand -base64 48` |
| `CREDENTIALS_ENCRYPTION_KEY` | `openssl rand -base64 48` (o **mesmo** valor no worker) |
| `AUTH_URL` | `https://seu-projeto.vercel.app` (ou seu domínio) |
| `AUTH_TRUST_HOST` | `true` |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` | Os da sua Evolution (ou os valores de exemplo, se ainda não usa WhatsApp) |
| `WHATSAPP_WEBHOOK_TOKEN` | `openssl rand -hex 32` |
| `APP_PUBLIC_URL` | A mesma URL pública do site |

5. **Deploy.** O build gera o Prisma client com o alvo `rhel-openssl-3.0.x` (o `schema.prisma` já inclui).

Conferir: `https://seu-projeto.vercel.app/api/health` responde JSON e `/login` abre.

## 3. O worker

Na máquina do worker (Node 20 e pnpm instalados):

```bash
git clone https://github.com/llmsa2025/CRM-Agro.git && cd CRM-Agro
pnpm install --frozen-lockfile
cp .env.example .env     # preencha com os MESMOS valores de DATABASE_URL, REDIS_URL, CREDENTIALS_ENCRYPTION_KEY, AUTH_SECRET e EVOLUTION_*
npm install -g pm2
pm2 start scripts/run-worker.sh --interpreter bash --name crmagro-worker
pm2 save && pm2 startup
```

Conferir: `pm2 logs crmagro-worker` sem erros de conexão e, em `/api/health` do site, o item do worker como ativo.

No Railway ou Render use como **comando de start**: `pnpm install --frozen-lockfile && bash scripts/run-worker.sh`, com as variáveis do `.env` cadastradas no painel do serviço.

## 4. Limites a ter em mente

- Funções serverless têm tempo máximo de execução. Tarefas longas (captação, importação grande) rodam no worker, não no site.
- Sem Socket.IO, o inbox de Conversas atualiza por polling.
- O `DATABASE_URL` com pooler precisa de `connection_limit` baixo (3 a 5) porque cada instância serverless abre o próprio pool.
- Com o banco no pooler em modo transação, as migrations só funcionam pela `DIRECT_URL`. Nunca rode `migrate` pelo pooler.
