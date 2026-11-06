-- "Editar" POR TELA (pedido do dono, 28/09/2026): além de "Só os meus" e "Ver
-- de todos", cada tela ganha "Ver e editar de todos". `editarTudoEm` = telas em
-- que a pessoa ALTERA os registros dos colegas; sempre dentro de `verTudoEm`
-- (o app normaliza). Coluna com default constante: só metadado no Postgres 11+.

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "editarTudoEm" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "editarTudoEm" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Ninguém perde o que já fazia: até aqui "ver tudo" também deixava alterar,
-- então quem vê de todos numa tela passa a ver E editar nela. Idempotente: só
-- preenche quem ainda está sem a lista de edição. Só travas de linha.
UPDATE "User"
SET "editarTudoEm" = "verTudoEm"
WHERE cardinality(coalesce("verTudoEm", ARRAY[]::TEXT[])) > 0
  AND cardinality(coalesce("editarTudoEm", ARRAY[]::TEXT[])) = 0;

UPDATE "Invite"
SET "editarTudoEm" = "verTudoEm"
WHERE cardinality(coalesce("verTudoEm", ARRAY[]::TEXT[])) > 0
  AND cardinality(coalesce("editarTudoEm", ARRAY[]::TEXT[])) = 0;
