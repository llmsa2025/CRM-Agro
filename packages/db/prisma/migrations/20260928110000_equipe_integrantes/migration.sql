-- Equipe (plano-equipe-permissoes F2): "ver tudo", desativar, permissões de
-- equipe por administrador e telas por pessoa (F2b). Colunas com default
-- constante: só metadado no Postgres 11+, não reescreve as tabelas.

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "modulos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "permissoesEquipe" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verTudo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "desativadoEm" TIMESTAMP(3),
ADD COLUMN     "modulos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "permissoesEquipe" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verTudo" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: administradores de hoje já convidavam — mantêm "convidar".
-- Desativar e excluir ficam para o master liberar.
UPDATE "User" SET "permissoesEquipe" = ARRAY['convidar']::TEXT[] WHERE role = 'admin';
