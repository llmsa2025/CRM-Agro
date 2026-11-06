-- Mapa "código anônimo do WhatsApp (@lid) → telefone" (unificação de conversas).
-- ADITIVA: tabela nova e vazia, sem DROP nem ALTER em coluna existente. Nada que
-- já roda depende dela: quem não a conhece continua funcionando igual.
-- Gerada por `prisma migrate diff` (schema antigo → novo). A única trava é a
-- FK para "Team" (ALTER TABLE ... ADD CONSTRAINT pede um lock curto em "Team",
-- que é pequena). Desfazer = DROP TABLE "WhatsAppLid".

-- CreateTable
CREATE TABLE "WhatsAppLid" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "lid" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppLid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppLid_teamId_telefone_idx" ON "WhatsAppLid"("teamId", "telefone");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppLid_teamId_lid_key" ON "WhatsAppLid"("teamId", "lid");

-- AddForeignKey
ALTER TABLE "WhatsAppLid" ADD CONSTRAINT "WhatsAppLid_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
