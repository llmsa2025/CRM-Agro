# Variáveis de ambiente

O app valida o ambiente no boot (`packages/config`, com zod). Se faltar algo obrigatório ou vier num formato inválido, ele para e imprime qual campo está errado. Modelo: [`.env.example`](../.env.example).

Os scripts `scripts/run-web.sh` e `scripts/run-worker.sh` fazem `source` do `.env`, então valores com espaço ou caractere especial vão entre aspas.

## Obrigatórias

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | URL do PostgreSQL usada pelo app. Em banco gerenciado, a do pooler (ex.: `?pgbouncer=true&connection_limit=10`) |
| `DIRECT_URL` | Conexão direta, usada só pelo Prisma nas migrations. Em Postgres local é igual à `DATABASE_URL` |
| `REDIS_URL` | Redis das filas (BullMQ), limites de taxa e Socket.IO |
| `AUTH_SECRET` | Assina o JWT de sessão. 32+ caracteres. Trocar derruba todas as sessões |
| `CREDENTIALS_ENCRYPTION_KEY` | Chave AES-256-GCM dos tokens de integração gravados no banco. 32+ caracteres. Web e worker usam a **mesma**. Para girar a chave sem perder acesso, use `CREDENTIALS_ENCRYPTION_KEYS="nova,antiga"` e depois `packages/db/scripts/recifrar-credenciais.ts` |
| `EVOLUTION_API_URL` | Endereço da Evolution API (WhatsApp) |
| `EVOLUTION_API_KEY` | Chave da Evolution |
| `EVOLUTION_INSTANCE` | Nome base da instância |

As três da Evolution são validadas mesmo que você não use WhatsApp: deixe os valores do exemplo.

## Recomendadas

| Variável | Descrição |
|---|---|
| `AUTH_URL` | URL pública canônica. Usada em links de e-mail e para o cookie de sessão. Em dev, `http://localhost:3001` |
| `AUTH_TRUST_HOST` | `true` atrás de proxy (Caddy, Nginx, Vercel) |
| `APP_PUBLIC_URL` | URL pública base, usada para registrar o webhook da Evolution nas conexões novas |
| `WHATSAPP_WEBHOOK_TOKEN` | Segredo do webhook de entrada do WhatsApp. **Obrigatório em produção** (sem ele o endpoint recusa tudo) |
| `DEV_TEAM_ID` | Id do time do seed de desenvolvimento (`packages/db/prisma/seed.ts`) |
| `DATABASE_URL_TEST`, `DIRECT_URL_TEST` | Banco da suíte de testes do core |
| `DATABASE_URL_WORKER` | Pool próprio do worker (maior que o do web). Se definida, o `run-worker.sh` a usa no lugar da `DATABASE_URL` |

## Opcionais

| Variável | Descrição |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Login com Google. Sem os dois, o botão não aparece |
| `GOOGLE_INTEGRACOES_CLIENT_ID`, `GOOGLE_INTEGRACOES_CLIENT_SECRET`, `GOOGLE_INTEGRACOES_REDIRECT_URI` | Cliente OAuth da Agenda Google e do Gmail (separado do login) |
| `GOOGLE_AGENDA_PUSH`, `GOOGLE_AGENDA_LIBERADOS`, `GOOGLE_GMAIL_ENVIO` | Liga/desliga e quem pode conectar a Agenda e o envio pelo Gmail |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, `LINKEDIN_API_VERSION` | LinkedIn oficial (entrar e publicar no perfil) |
| `CADASTRO_EMPRESA`, `CADASTRO_EMPRESA_SENHA`, `SIGNUP_ABERTO` | Cadastro self-service de empresas (`on`/`off`). Com senha, exige o remetente da plataforma para confirmar o e-mail |
| `PLATFORM_EMAIL_FROM`, `PLATFORM_EMAIL_REPLY_TO`, `PLATFORM_SMTP_HOST`, `PLATFORM_SMTP_PORT`, `PLATFORM_SMTP_USER`, `PLATFORM_SMTP_PASS`, `PLATFORM_SMTP_SECURE`, `PLATFORM_EMAIL_LIMITE_DIA` | Remetente do sistema (reset de senha, convite, alerta). SMTP genérico: Resend, Amazon SES, Brevo, Postmark. Erro aqui não derruba o boot, só bloqueia esses e-mails |
| `EMAIL_ENTRADA_DOMINIO`, `EMAIL_ENTRADA_SEGREDO` | Entrada de e-mail por encaminhamento (opcional) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Armazenamento de mídia (bucket privado). Sem eles, o recurso de mídia fica desligado |
| `TAVILY_API_KEY` | Pesquisa na web para o agente de IA |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. Gere com `npx web-push generate-vapid-keys`. Sem as três, o push fica desligado |
| `NOMINATIM_URL`, `GEO_CONTATO` | Geocodificação do Mapa. O Nominatim público exige um contato no User-Agent: sem `GEO_CONTATO` só o centro da cidade é usado |
| `INSTAGRAM_BIO_MAX` | Bios buscadas por job na captação do Instagram (0 a 500, padrão 50; 0 desliga) |
| `WA_HISTORICO_MODO` | Importação automática do histórico do WhatsApp: `desligado` (padrão) ou `completo` |
| `CSP_MODO` | Política de segurança de conteúdo: `relatorio` (padrão, só registra), `aplicada` (bloqueia) ou `desligada` |
| `CONTATOS_CIFRA`, `CONTATOS_INDICE_KEY`, `CONTATOS_INDICE_KEY_ANTERIOR` | Cifra de e-mail e telefone dos contatos no banco: `off` (padrão), `dupla`, `indice`, `ligada`. Fora do `off` a `CONTATOS_INDICE_KEY` (32+) é obrigatória. Ligue em etapas e com backup antes |
| `DATABASE_URL_APP`, `DATABASE_URL_APP_WORKER` | Conexão por um papel restrito do Postgres com RLS por time (camada extra de isolamento). Desligada por padrão |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Só se a Evolution estiver atrás de um Cloudflare Tunnel com Access |
| `WORKER_PRIMARY` | Com mais de um worker, só um pode ser `true` (ele roda as tarefas únicas: poll de e-mail, verificação social, captura) |

## Como gerar valores

```bash
openssl rand -base64 48     # AUTH_SECRET, CREDENTIALS_ENCRYPTION_KEY, CONTATOS_INDICE_KEY
openssl rand -hex 32        # WHATSAPP_WEBHOOK_TOKEN
npx web-push generate-vapid-keys
```
