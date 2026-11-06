-- Item 0.8 (auditoria INT-02): Duas conversas do mesmo contato na mesma conta (primeiro inbound concorrente).
-- Índice único PARCIAL — o schema.prisma não expressa (ver comentário no model).
-- ANTES em produção: node scripts/dedup-inbound.mjs --aplicar (senão o índice falha).
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Conversation_account_contact_uq" ON "Conversation"("channelAccountId", "contactId") WHERE "contactId" IS NOT NULL;
