-- Equipe/empresa (plano-equipe-permissoes F1): dados da empresa no time e
-- e-mail comprovado no usuário. Colunas nulas: só metadado, não reescreve a tabela.

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "cidade" TEXT,
ADD COLUMN     "cnpj" TEXT,
ADD COLUMN     "estado" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerificadoEm" TIMESTAMP(3);

-- Backfill: quem já existe entrou por convite (link no e-mail), Google ou pelo
-- dono — conta como comprovado. Só as contas novas de /criar-empresa nascem nulas.
UPDATE "User" SET "emailVerificadoEm" = COALESCE("lastLoginAt", "createdAt") WHERE "emailVerificadoEm" IS NULL;
