# Demo e prints

O repositório traz uma base de demonstração **100% fictícia** (nomes, fazendas, telefones e e-mails inventados) e um script que tira os prints das telas.

## Carregar a demonstração

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed:demo            # use --reset para apagar e recriar
```

Entre com `demo@crmagro.example` e `DemoCrmAgro2026!`.

O que vem na demo: 36 contatos de MT, GO, MS, BA, MG e PR (com tipo de agro, tags e coordenadas para o Mapa), um funil de vendas com 14 negócios, 7 conversas de WhatsApp e 3 de e-mail, 2 campanhas, 13 compromissos na agenda, 3 fluxos (um deles com 9 nós, para o editor visual) e uma semana de atividades para o Painel.

O script recusa rodar contra banco que não seja local. O usuário demo é dono do time e a senha padrão é pública, então nunca use em produção. Para forçar num ambiente de teste remoto, combine `SEED_DEMO_PERMITIR_REMOTO=1` com `DEMO_SENHA=<uma senha sua>`.

## Tirar os prints

Com o app no ar (`pnpm dev` ou `pnpm start:web`) e o seed aplicado:

```bash
pnpm --filter @crmagro/worker exec playwright-core install chromium   # uma vez
pnpm demo:screenshots
```

Saída em `screenshots/`:

- `desktop/`: 1680×1050 (a 1,5x), para README e artigos
- `linkedin/`: 1600×838 (a 1,5x), proporção 1,91:1 de imagem de post do LinkedIn
- `dark/`: tema escuro, telas principais

Variáveis: `BASE_URL` (padrão `http://localhost:3001`), `OUT` (pasta de saída), `DEMO_EMAIL` e `DEMO_SENHA`.

## Gerar os prints no GitHub Actions

O workflow **Demo e prints** (`.github/workflows/demo-screenshots.yml`) sobe tudo do zero num ambiente limpo (Postgres, Redis, migrations, seed, build, servidor) e publica os prints como artefato. Rode em **Actions > Demo e prints > Run workflow**. Serve também como teste de que o passo a passo do README funciona.
