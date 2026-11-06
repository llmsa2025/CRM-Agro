-- "Ver tudo" POR TELA (pedido do dono, 28/09/2026): no lugar do booleano
-- `verTudo` (tudo ou nada), a lista das telas em que a pessoa vê os registros
-- de todos do time — ex.: Contatos de todos, Conversas só as dela. Coluna com
-- default constante: só metadado no Postgres 11+.

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "verTudoEm" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "verTudoEm" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Conversão: quem tinha "ver tudo" passa a ver de todos em TODAS as telas com
-- dono (MODULOS_COM_DONO em packages/core/src/auth/modulos.ts). Nada muda
-- para ninguém. `verTudo` fica (obsoleto, sem uso) até a próxima migration,
-- para o app antigo não quebrar entre a migration e o deploy. Idempotente.
UPDATE "User"
SET "verTudoEm" = ARRAY['contatos', 'funis', 'conversas', 'ligacoes', 'campanhas', 'fluxos', 'captacao']::TEXT[]
WHERE "verTudo" = true AND cardinality(coalesce("verTudoEm", ARRAY[]::TEXT[])) = 0;

UPDATE "Invite"
SET "verTudoEm" = ARRAY['contatos', 'funis', 'conversas', 'ligacoes', 'campanhas', 'fluxos', 'captacao']::TEXT[]
WHERE "verTudo" = true AND cardinality(coalesce("verTudoEm", ARRAY[]::TEXT[])) = 0;
