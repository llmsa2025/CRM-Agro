-- Passo 8.5: identifiers multicanal + relacionamentoStatus.
--
-- Ordem cuidadosa para PRESERVAR DADOS:
--   1. cria o enum e a tabela ChannelIdentifier (+ índices/FKs)
--   2. adiciona relacionamentoStatus ao Contact
--   3. BACKFILL: copia telefone (→ whatsapp) e email (→ email) existentes
--      pra ChannelIdentifier. Neste ponto as colunas telefone/email ainda
--      existem e a tabela ChannelIdentifier já existe.
--   4. só então dropa os índices e as colunas telefone/email do Contact.
--   5. cria o índice de relacionamentoStatus.
--
-- gen_random_uuid() é nativo no PostgreSQL 13+ (Supabase roda PG15+).

-- CreateEnum
CREATE TYPE "RelacionamentoStatus" AS ENUM ('novo', 'ja_conversou', 'cliente', 'opt_out');

-- CreateTable
CREATE TABLE "ChannelIdentifier" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "canal" "Canal" NOT NULL,
    "valor" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelIdentifier_teamId_canal_idx" ON "ChannelIdentifier"("teamId", "canal");

-- CreateIndex
CREATE INDEX "ChannelIdentifier_contactId_idx" ON "ChannelIdentifier"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIdentifier_teamId_canal_valor_key" ON "ChannelIdentifier"("teamId", "canal", "valor");

-- AddForeignKey
ALTER TABLE "ChannelIdentifier" ADD CONSTRAINT "ChannelIdentifier_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelIdentifier" ADD CONSTRAINT "ChannelIdentifier_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: adiciona relacionamentoStatus (drop das colunas vem DEPOIS do backfill)
ALTER TABLE "Contact" ADD COLUMN "relacionamentoStatus" "RelacionamentoStatus" NOT NULL DEFAULT 'novo';

-- Backfill: telefone → identifier whatsapp (isPrimary=true)
INSERT INTO "ChannelIdentifier" ("id", "teamId", "contactId", "canal", "valor", "isPrimary", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "teamId", "id", 'whatsapp', "telefone", true, NOW(), NOW()
FROM "Contact"
WHERE "telefone" IS NOT NULL;

-- Backfill: email → identifier email (isPrimary=true, lowercased)
INSERT INTO "ChannelIdentifier" ("id", "teamId", "contactId", "canal", "valor", "isPrimary", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "teamId", "id", 'email', lower("email"), true, NOW(), NOW()
FROM "Contact"
WHERE "email" IS NOT NULL;

-- DropIndex
DROP INDEX "Contact_teamId_email_idx";

-- DropIndex
DROP INDEX "Contact_teamId_telefone_idx";

-- AlterTable: agora sim dropa as colunas migradas pra ChannelIdentifier
ALTER TABLE "Contact" DROP COLUMN "email",
DROP COLUMN "telefone";

-- CreateIndex
CREATE INDEX "Contact_teamId_relacionamentoStatus_idx" ON "Contact"("teamId", "relacionamentoStatus");
