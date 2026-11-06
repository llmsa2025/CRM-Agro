-- Item 2.7 (DP-14): versão do fluxo deduplicada por hash. A inscrição nova
-- aponta para a FlowVersion em vez de copiar o grafo inteiro no flowSnapshot;
-- a antiga (flowVersionId nulo) continua lendo o próprio flowSnapshot.
-- O índice de Enrollment.flowVersionId vem no arquivo seguinte (CONCURRENTLY).

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "flowVersionId" TEXT;

-- CreateTable
CREATE TABLE "FlowVersion" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowVersion_teamId_idx" ON "FlowVersion"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowVersion_flowId_hash_key" ON "FlowVersion"("flowId", "hash");

-- AddForeignKey
-- NOT VALID: não varre as linhas existentes (todas nulas) segurando o lock de
-- Enrollment — o motor não para durante a migration. Linha nova/alterada é
-- conferida normalmente.
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_flowVersionId_fkey" FOREIGN KEY ("flowVersionId") REFERENCES "FlowVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "FlowVersion" ADD CONSTRAINT "FlowVersion_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowVersion" ADD CONSTRAINT "FlowVersion_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
