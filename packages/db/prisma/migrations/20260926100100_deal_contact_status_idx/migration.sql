-- Item 2.1 (plano de backend 09/2026). CONCURRENTLY: não trava escrita; um
-- statement por arquivo (CONCURRENTLY não roda dentro de transação).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Deal_contactId_status_idx" ON "Deal"("contactId", "status");
