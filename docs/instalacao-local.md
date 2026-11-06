# Instalação local

Para desenvolver, testar ou conhecer o produto na sua máquina (macOS, Linux ou Windows com WSL2).

## Requisitos

- Node.js 20+
- pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- Docker com Compose v2 (ou um PostgreSQL 15+ e um Redis 7+ seus)
- git

## Passo a passo

```bash
git clone https://github.com/llmsa2025/CRM-Agro.git && cd CRM-Agro
pnpm install
cp .env.example .env
```

Gere os dois segredos obrigatórios e grave no `.env`:

```bash
sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=\"$(openssl rand -base64 48)\"|" .env
sed -i "s|^CREDENTIALS_ENCRYPTION_KEY=.*|CREDENTIALS_ENCRYPTION_KEY=\"$(openssl rand -base64 48)\"|" .env
```

(No macOS: `sed -i ''`. No Windows, rode dentro do WSL2.)

Suba o banco e o Redis, aplique as migrations e carregue a demonstração:

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed:demo
pnpm dev
```

Abra <http://localhost:3001> (use `localhost`, não `127.0.0.1`) e entre com:

- e-mail: `demo@crmagro.example`
- senha: `DemoCrmAgro2026!`

O `pnpm dev` sobe o web (porta 3001, recarrega ao salvar) e o worker juntos.

## Usando seu próprio PostgreSQL e Redis

Ajuste `DATABASE_URL`, `DIRECT_URL` e `REDIS_URL` no `.env` e pule o `docker compose up`. O banco precisa existir e o usuário precisa poder criar tabelas. Para rodar os testes, crie também um banco separado e aponte `DATABASE_URL_TEST` e `DIRECT_URL_TEST` para ele.

## WhatsApp local

```bash
docker compose --profile whatsapp up -d       # Evolution API em 127.0.0.1:8081
```

No `.env`: `EVOLUTION_API_KEY` igual à chave do container (o compose lê o `EVOLUTION_API_KEY` do seu `.env` sozinho, então basta definir o valor ali) e `APP_PUBLIC_URL="http://host.docker.internal:3001"` para a Evolution conseguir chamar o webhook do app que roda no seu computador. Conecte o aparelho em **Integrações > Canais**.

## Testes e qualidade

```bash
pnpm -r typecheck
# banco de teste: aplique as migrations nele uma vez
DATABASE_URL="postgresql://crmagro:crmagro@localhost:5432/crmagro_test" pnpm --filter @crmagro/db exec prisma migrate deploy
pnpm --filter @crmagro/core test            # suíte do domínio (usa DATABASE_URL_TEST)
pnpm --filter @crmagro/web test             # testes do web
pnpm lint
```

## Comandos úteis

| Comando | O que faz |
|---|---|
| `pnpm dev` | Web e worker em modo desenvolvimento |
| `pnpm db:migrate` | Aplica as migrations existentes (`prisma migrate deploy`) |
| `pnpm --filter @crmagro/db migrate` | Cria uma migration nova a partir do `schema.prisma` (desenvolvimento) |
| `pnpm --filter @crmagro/db studio` | Prisma Studio para olhar as tabelas |
| `pnpm db:seed:demo --reset` | Apaga e recria o time de demonstração |
| `pnpm db:create-user <email> "<nome>" --novo-time "<empresa>"` | Cria um usuário e um time (senha por stdin) |
| `pnpm services:down` / `pnpm services:reset` | Para os containers / apaga os volumes e recomeça |
| `pnpm demo:screenshots` | Tira os prints da demo (veja [demo-e-prints.md](demo-e-prints.md)) |
