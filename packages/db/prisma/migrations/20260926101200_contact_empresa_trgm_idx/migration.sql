-- Item 2.1 (plano de backend 09/2026). CONCURRENTLY: não trava escrita; um
-- statement por arquivo (CONCURRENTLY não roda dentro de transação).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_empresa_trgm_idx" ON "Contact" USING GIN ("empresa" gin_trgm_ops);
