-- Escopo por dono (plano-equipe-permissoes F3): cada registro tem dono e o
-- membro/só leitura vê só o que é dele (ou compartilhado). Colunas nulas ou com
-- default constante: só metadado. Índices em arquivos próprios (CONCURRENTLY).

-- AlterTable
ALTER TABLE "ProspectDraft" ADD COLUMN     "ownerId" TEXT;
ALTER TABLE "Contact" ADD COLUMN     "compartilhado" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Activity" ADD COLUMN     "userId" TEXT;
ALTER TABLE "ChannelAccount" ADD COLUMN     "ownerId" TEXT;
ALTER TABLE "Call" ADD COLUMN     "userId" TEXT;
ALTER TABLE "Deal" ADD COLUMN     "ownerId" TEXT;
ALTER TABLE "Flow" ADD COLUMN     "compartilhado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "createdById" TEXT;
ALTER TABLE "Campaign" ADD COLUMN     "compartilhado" BOOLEAN NOT NULL DEFAULT false;

-- O backfill fica em 20260928120050_escopo_backfill: numa transação própria,
-- para a trava exclusiva destes ALTER não durar o UPDATE das tabelas grandes.
