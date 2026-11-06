-- Escopo por dono (F3): negócios "só os meus" no funil.
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Deal_teamId_ownerId_idx" ON "Deal"("teamId", "ownerId");
