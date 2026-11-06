# Deploy em VPS (Ubuntu, pm2 e Caddy)

Caminho recomendado: tudo num servidor só. O site e o worker rodam sob o **pm2**, o **Caddy** põe HTTPS na frente, e o PostgreSQL e o Redis rodam no Docker (ou em serviços gerenciados, se preferir).

Tamanho mínimo: **2 vCPU e 4 GB de RAM**. O `next build` do web usa cerca de 3 GB; com menos que isso, crie swap (passo 1) ou faça o build no CI.

## 1. Preparar o servidor (Ubuntu 22.04 ou 24.04)

```bash
sudo apt update && sudo apt install -y git curl ufw ca-certificates

# Node 20 e pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable && corepack prepare pnpm@9.15.9 --activate

# Docker (PostgreSQL e Redis) e pm2
curl -fsSL https://get.docker.com | sudo sh
sudo npm install -g pm2

# Swap de 2 GB (só se o servidor tem menos de 4 GB livres para o build)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Firewall: só SSH, HTTP e HTTPS. O Postgres e o Redis ficam presos em `127.0.0.1` pelo compose.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
```

Caddy (HTTPS automático): siga a instalação oficial em <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>.

## 2. Baixar o código e configurar

```bash
git clone https://github.com/llmsa2025/CRM-Agro.git ~/crm-agro && cd ~/crm-agro
cp .env.example .env
```

Edite o `.env`. Em produção:

```bash
sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=\"$(openssl rand -base64 48)\"|" .env
sed -i "s|^CREDENTIALS_ENCRYPTION_KEY=.*|CREDENTIALS_ENCRYPTION_KEY=\"$(openssl rand -base64 48)\"|" .env
sed -i "s|^WHATSAPP_WEBHOOK_TOKEN=.*|WHATSAPP_WEBHOOK_TOKEN=\"$(openssl rand -hex 32)\"|" .env
sed -i "s|^AUTH_URL=.*|AUTH_URL=\"https://crm.seu-dominio.com\"|" .env
```

Troque também a senha do Postgres (`crmagro`) no `docker-compose.yml` e nas URLs do `.env`, já que o banco guarda dados reais. **Guarde uma cópia do `.env` fora do servidor**: as chaves de cifra não têm como ser recuperadas.

## 3. Banco, dependências e build

```bash
docker compose up -d                      # PostgreSQL e Redis
pnpm install --frozen-lockfile
pnpm db:migrate                           # prisma migrate deploy
pnpm --filter @crmagro/web build          # leva alguns minutos e ~3 GB de RAM
```

Crie o primeiro usuário (a senha vai por pipe para não ficar no histórico do shell):

```bash
printf 'UmaSenhaForte123\nUmaSenhaForte123\n' | pnpm db:create-user voce@empresa.com "Seu Nome" --novo-time "Minha Empresa"
```

## 4. Subir com o pm2

```bash
pm2 start ecosystem.config.cjs            # crmagro-web (3001) e crmagro-worker
pm2 save
pm2 startup                               # rode o comando que ele imprimir, para subir no boot
pm2 status                                # os dois devem estar "online"
```

O web escuta só em `127.0.0.1:3001`. Quem atende a internet é o Caddy.

## 5. HTTPS com Caddy

Aponte o DNS do seu domínio (registro A) para o IP do servidor. Copie `deploy/Caddyfile.example` para `/etc/caddy/Caddyfile`, troque o domínio e recarregue:

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile            # troque crm.seu-dominio.com pelo seu domínio
sudo systemctl reload caddy
```

## 6. Conferir

```bash
curl -s https://crm.seu-dominio.com/api/health     # JSON com o estado de banco, Redis e worker
pm2 logs crmagro-web --lines 30
pm2 logs crmagro-worker --lines 30
```

Abra `https://crm.seu-dominio.com/login` e entre com o usuário criado. Em `/api/health`, `healthy` significa banco, Redis, worker e Evolution no ar. `degraded` (HTTP 200) é normal enquanto você não configurar o WhatsApp; `unhealthy` (HTTP 503) é banco ou Redis fora do ar.

## 7. WhatsApp (opcional)

```bash
docker compose --profile whatsapp up -d            # Evolution API em 127.0.0.1:8081
```

No `.env`: `EVOLUTION_API_URL="http://localhost:8081"`, `EVOLUTION_API_KEY` igual à chave da Evolution, e `APP_PUBLIC_URL="https://crm.seu-dominio.com"`. Reinicie com `pm2 startOrReload ecosystem.config.cjs --update-env` e conecte o aparelho em **Integrações > Canais** (QR code).

Aviso: a Evolution usa o protocolo não oficial do WhatsApp. Há risco de banimento do número em envio em massa. Respeite os limites diários do CRM e prefira a API oficial para volume alto.

## 8. Atualizar

```bash
cd ~/crm-agro && git pull
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm --filter @crmagro/web build
pm2 startOrReload ecosystem.config.cjs --update-env
```

`pm2 restart <nome>` **não** relê o `ecosystem.config.cjs`; use sempre o `startOrReload` acima.

## 9. Backup

```bash
mkdir -p ~/backups
docker compose exec -T postgres pg_dump -U crmagro crmagro | gzip > ~/backups/crmagro-$(date +%F).sql.gz
```

Agende no `crontab -e` (`30 3 * * * cd ~/crm-agro && ...`) e copie os arquivos para fora do servidor.

## 10. Captura pelo Google Maps (opcional)

O worker usa o Chromium do Playwright nessa captação:

```bash
pnpm --filter @crmagro/worker exec playwright-core install --with-deps chromium
```
