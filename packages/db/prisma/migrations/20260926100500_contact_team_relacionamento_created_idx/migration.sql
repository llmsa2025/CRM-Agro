-- Item 2.1 (plano de backend 09/2026). CONCURRENTLY: não trava escrita; um
-- statement por arquivo (CONCURRENTLY não roda dentro de transação).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_teamId_relacionamentoStatus_createdAt_idx" ON "Contact"("teamId", "relacionamentoStatus", "createdAt" DESC);
