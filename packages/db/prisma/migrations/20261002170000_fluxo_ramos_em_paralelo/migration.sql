-- Condição com vários destinos na mesma saída: cada destino extra vira um RAMO (inscrição filha) que roda ao mesmo
-- tempo. Troca a coluna `pendentes` (nunca usada em produção) por `paiId` e deixa os ramos fora do índice de
-- "uma inscrição ativa por (fluxo, contato)". Um script só: o DROP e o CREATE do índice acontecem juntos.
ALTER TABLE "Enrollment" DROP COLUMN IF EXISTS "pendentes";
ALTER TABLE "Enrollment" ADD COLUMN "paiId" TEXT;
CREATE INDEX "Enrollment_paiId_idx" ON "Enrollment"("paiId");
DROP INDEX IF EXISTS "Enrollment_um_ativo";
CREATE UNIQUE INDEX "Enrollment_um_ativo" ON "Enrollment"("flowId", "contactId") WHERE status IN ('active', 'waiting') AND "paiId" IS NULL;
