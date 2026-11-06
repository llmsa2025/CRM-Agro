-- F1B-05: índice das ligações de uma linha. CONCURRENTLY: não trava a escrita em Call; um statement por
-- arquivo (CONCURRENTLY não roda dentro de transação).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Call_linhaId_createdAt_idx" ON "Call"("linhaId", "createdAt");
