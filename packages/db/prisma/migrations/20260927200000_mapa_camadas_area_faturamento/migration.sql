-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "areaHa" DOUBLE PRECISION,
ADD COLUMN     "camadaId" TEXT,
ADD COLUMN     "faturamentoAnual" DOUBLE PRECISION;
-- CreateTable
CREATE TABLE "MapaCamada" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cor" TEXT NOT NULL DEFAULT '#1F4A3A',
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MapaCamada_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "MapaCamada_teamId_ordem_idx" ON "MapaCamada"("teamId", "ordem");
-- CreateIndex
CREATE UNIQUE INDEX "MapaCamada_teamId_nome_key" ON "MapaCamada"("teamId", "nome");
-- CreateIndex
CREATE INDEX "Contact_teamId_camadaId_idx" ON "Contact"("teamId", "camadaId");
-- CreateIndex
CREATE INDEX "Contact_teamId_areaHa_idx" ON "Contact"("teamId", "areaHa");
-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_camadaId_fkey" FOREIGN KEY ("camadaId") REFERENCES "MapaCamada"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "MapaCamada" ADD CONSTRAINT "MapaCamada_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
