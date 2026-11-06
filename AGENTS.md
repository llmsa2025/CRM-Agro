# AGENTS.md: guia para IA (e para gente com pressa)

Este arquivo é um roteiro executável. Se você é um agente de IA (Claude Code, Cursor, Codex, Copilot, Gemini CLI ou outro) e recebeu o pedido "coloque o CRM Agro para rodar", siga na ordem. Cada passo diz como conferir que deu certo. Se um passo falhar, vá para a seção **Problemas comuns** antes de improvisar.

## 0. O que é este projeto

CRM de prospecção para o agro. Uma base única de contatos (a espinha) e um motor de automação em cima dela: funis (kanban), conversas de WhatsApp em tempo real, fluxos visuais, campanhas, agenda, mapa e captação. Monorepo pnpm, TypeScript estrito.

| Peça | Onde | Roda como |
|---|---|---|
| Web (UI + API) | `apps/web` | Next.js (App Router) com servidor próprio (`server.ts`, Socket.IO), porta 3001 |
| Worker | `apps/worker` | Processo contínuo (BullMQ). **Não roda em serverless** |
| Domínio e serviços | `packages/core` | Biblioteca (sem build, TS direto) |
| Banco | `packages/db` | Prisma + PostgreSQL |
| Canais | `packages/channels` | WhatsApp (Evolution API), e-mail, etc. |
| Captação | `packages/captation` | Maps, CNPJ, Instagram |
| Env validado | `packages/config` | zod, falha cedo no boot |

Dependências externas: **PostgreSQL 15+**, **Redis 7+**, e (opcional, para WhatsApp) **Evolution API**.

## 1. Pré-requisitos

- Node.js 20 ou mais novo (`node -v`)
- pnpm 9.15.9: `corepack enable && corepack prepare pnpm@9.15.9 --activate` (`pnpm -v`)
- Docker com Compose v2 (`docker compose version`), ou um PostgreSQL e um Redis seus
- git

## 2. Rodar na sua máquina (6 comandos)

```bash
git clone https://github.com/llmsa2025/CRM-Agro.git && cd CRM-Agro
pnpm install                       # também gera o client do Prisma (postinstall)
cp .env.example .env               # depois preencha AUTH_SECRET e CREDENTIALS_ENCRYPTION_KEY (passo 2.1)
docker compose up -d               # PostgreSQL 5432 e Redis 6379, presos em 127.0.0.1
pnpm db:migrate                    # aplica as migrations
pnpm db:seed:demo                  # opcional: dados fictícios e o usuário de demonstração
pnpm dev                           # web em http://localhost:3001 e worker
```

### 2.1 Gerar os segredos do `.env`

```bash
sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=\"$(openssl rand -base64 48)\"|" .env
sed -i "s|^CREDENTIALS_ENCRYPTION_KEY=.*|CREDENTIALS_ENCRYPTION_KEY=\"$(openssl rand -base64 48)\"|" .env
```

No macOS o `sed -i` pede um argumento: use `sed -i '' ...`.

### 2.2 Como conferir

1. `curl -s http://localhost:3001/api/health` responde JSON com o estado de cada peça. `healthy` é tudo no ar. `degraded` (HTTP 200) é site no ar com Evolution ou worker fora: esperado se você ainda não subiu o WhatsApp. `unhealthy` (HTTP 503) é banco ou Redis fora do ar.
2. Abra `http://localhost:3001/login`. Use **`localhost`**, nunca `127.0.0.1`: o cookie de sessão é emitido para o host de `AUTH_URL`.
3. Entre com o usuário de demonstração: `demo@crmagro.example` / `DemoCrmAgro2026!` (só existe depois do `pnpm db:seed:demo`).

### 2.3 Sem o seed demo: criar o seu primeiro usuário

A senha é lida do stdin (não vai para o histórico do shell). Para rodar sem terminal interativo, mande-a por pipe, duas vezes (senha e confirmação):

```bash
printf 'UmaSenhaForte123\nUmaSenhaForte123\n' | pnpm db:create-user voce@empresa.com "Seu Nome" --novo-time "Minha Empresa"
```

Isso cria um time novo com você como dono, mais o funil "Vendas" de 5 etapas e a meta do mês.

## 3. Variáveis de ambiente

Só 7 são obrigatórias no boot (mais a `DIRECT_URL`, que o Prisma usa para migrar). O boot valida com zod e imprime exatamente o que falta. Lista completa em [`docs/variaveis-de-ambiente.md`](docs/variaveis-de-ambiente.md).

| Variável | Para quê | Como obter |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL (a segunda é usada nas migrations) | Os valores do `.env.example` casam com o `docker-compose.yml` |
| `REDIS_URL` | Filas, limites de taxa, Socket.IO | Idem |
| `AUTH_SECRET` | Assina a sessão | `openssl rand -base64 48` |
| `CREDENTIALS_ENCRYPTION_KEY` | Cifra tokens de integrações no banco | `openssl rand -base64 48` (não troque depois de gravar credenciais) |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` | WhatsApp. Validadas no boot mesmo sem uso | Deixe os valores do exemplo se ainda não vai usar WhatsApp |
| `AUTH_URL` | URL pública do app (links de e-mail, cookies) | `http://localhost:3001` local; `https://seu-dominio` em produção |

## 4. Colocar no ar

Escolha um destino. Cada guia tem comandos completos e a verificação final.

| Destino | Quando escolher | Guia |
|---|---|---|
| **VPS** (Ubuntu + pm2 + Caddy) | Quer tudo num servidor só, com Socket.IO e worker. **É o caminho recomendado** | [`docs/deploy-vps.md`](docs/deploy-vps.md) |
| **Vercel** (web) + worker em outro lugar | Já usa Vercel e aceita banco e Redis gerenciados | [`docs/deploy-vercel.md`](docs/deploy-vercel.md) |
| **Local** | Desenvolver, testar, tirar prints | [`docs/instalacao-local.md`](docs/instalacao-local.md) |

Regra que vale para todos: **o worker precisa de um processo vivo** (VPS, container, Railway, Render, Fly). Sem ele o site abre, mas nenhum fluxo, campanha ou envio é processado.

## 5. Estrutura do código e regras ao alterar

```
apps/web         Next.js: telas em app/<módulo>, rotas de API em app/api, server.ts (Socket.IO)
apps/worker      Processa as filas (fluxos, campanhas, inbound, captação, agenda)
packages/core    Regra de negócio por domínio: contacts, flows, funnels, conversations, campaigns, agenda...
packages/db      schema.prisma, migrations, client com isolamento por time
```

Regras do projeto (testes e revisão cobram):

1. **Multiempresa.** Toda tabela do cliente tem `teamId`. Serviços chamam `db()` (de `@crmagro/db`) dentro de um contexto de time (`runWithTeam`, `runAsSystem` no worker); sem time no contexto, a consulta devolve zero linhas. Todo id vindo do cliente que vira chave estrangeira passa por `assertOwned`/`assertOwnedMany` (`packages/core/src/tenancy/assert-owned.ts`) antes de gravar.
2. **Permissão no serviço.** Toda função de escrita do core começa com `requireCan("<ação>")` (`packages/core/src/auth/authz.ts`). Motor, webhooks e jobs usam `runAsSystem(teamId, fn)`.
3. **zod em toda borda.** API, webhook, formulário e resposta de integração passam por schema; os tipos saem de `z.infer`.
4. **Sem lógica na UI.** Componentes chamam serviços e server actions tipados.
5. **O motor nunca envia direto.** Passa pela interface `Channel` (`packages/channels`). Trocar o provedor de WhatsApp não mexe no motor.
6. **Migrations versionadas.** `pnpm --filter @crmagro/db migrate` cria uma nova (desenvolvimento). Nunca `prisma db push`. Tabela nova com `teamId` precisa de política de RLS na migration (o teste `tenancy/rls.test.ts` cobra).
7. **Texto da interface** (rótulos, avisos, e-mails, mensagens que a IA escreve): português do Brasil do dia a dia, verbo no começo do botão, frases curtas, sem travessão (—) nem meia-risca (–) como pontuação, sem exclamação em excesso, sem jargão de marketing. Prompts de IA que geram texto para contato incluem `REGRA_ESTILO_HUMANO` (`packages/core/src/ai/estilo.ts`).

Antes de abrir PR: `pnpm -r typecheck && pnpm --filter @crmagro/core test`. Os testes do core usam o banco `DATABASE_URL_TEST` (o `docker compose` cria o `crmagro_test`; aplique as migrations nele com `DATABASE_URL=$DATABASE_URL_TEST pnpm --filter @crmagro/db exec prisma migrate deploy`).

## 6. Problemas comuns

| Sintoma | Causa e correção |
|---|---|
| `❌ Variáveis de ambiente inválidas` no boot | O `.env` não tem uma obrigatória ou ela é curta. `AUTH_SECRET` e `CREDENTIALS_ENCRYPTION_KEY` pedem 32+ caracteres. Leia o campo apontado na saída |
| `ERR_PNPM_OUTDATED_LOCKFILE` | Use `pnpm install` (sem `--frozen-lockfile`) ao alterar dependências e commite o `pnpm-lock.yaml` |
| `P1001: Can't reach database server` | O Postgres não subiu (`docker compose ps`) ou a porta 5432 já está em uso: troque o mapeamento no compose e o `.env` |
| `ECONNREFUSED 127.0.0.1:6379` | Redis fora do ar: `docker compose up -d redis` |
| Login volta para a tela de login sem erro | Você abriu por `127.0.0.1` ou por um host diferente do `AUTH_URL`. Use o mesmo host do `AUTH_URL` |
| `Environment variable not found: DIRECT_URL` ao migrar | Defina `DIRECT_URL` (igual à `DATABASE_URL` em Postgres local) |
| `next build` morre sem mensagem (código 137) | Falta de memória. O build do web pede ~3 GB livres. Crie swap de 2 GB ou faça o build no CI e leve o resultado pronto |
| Página abre mas nada é enviado nem processado | O worker não está rodando (`pnpm dev` sobe os dois; em produção `pm2 status`) |
| WhatsApp não conecta | Suba a Evolution (`docker compose --profile whatsapp up -d`), confira que `EVOLUTION_API_KEY` do `.env` é a mesma usada pelo container e que `APP_PUBLIC_URL` é alcançável pela Evolution |
| Porta 3001 em uso | `WEB_PORT=3002 pnpm start:web` em produção; em dev, `PORT=3002 pnpm --filter @crmagro/web dev` (e ajuste `AUTH_URL`) |

## 7. Segurança (leia antes de publicar)

- O `.env` nunca vai para o git. Se vazar um segredo, gere outro e troque.
- `CREDENTIALS_ENCRYPTION_KEY` e `CONTATOS_INDICE_KEY` guardam dados cifrados: faça cópia fora do servidor. Perder a chave é perder o acesso aos dados cifrados.
- Em produção defina `WHATSAPP_WEBHOOK_TOKEN` (sem ele o webhook recusa tudo).
- Postgres e Redis ficam presos em `127.0.0.1` no compose. Se expor para a internet, use senha forte e firewall.
- Respeite a LGPD e os termos de cada canal. Disparo em massa por WhatsApp não oficial pode banir o número; veja [`SECURITY.md`](SECURITY.md).
