# Contribuindo

Contribuições são bem-vindas: correção de bug, melhoria de texto, novo canal, nova captação.

1. Faça um fork e crie uma branch (`feat/...`, `fix/...`, `docs/...`).
2. Rode o projeto local pelo [`docs/instalacao-local.md`](docs/instalacao-local.md).
3. Siga as regras de [`AGENTS.md`](AGENTS.md), seção 5 (multiempresa, permissão no serviço, zod nas bordas, migrations versionadas, texto da interface).
4. Antes de abrir o PR: `pnpm -r typecheck` e `pnpm --filter @crmagro/core test`.
5. Descreva no PR o que mudou e como testar.

Mudou o `schema.prisma`? Gere a migration com `pnpm --filter @crmagro/db migrate` e commite a pasta nova. Nunca use `prisma db push`.
