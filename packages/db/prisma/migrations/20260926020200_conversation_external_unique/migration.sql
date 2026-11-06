-- Item 0.8 (auditoria INT-02): Duas conversas do mesmo número não cadastrado na mesma conta.
-- Índice único PARCIAL — o schema.prisma não expressa (ver comentário no model).
-- ANTES em produção: node scripts/dedup-inbound.mjs --aplicar (senão o índice falha).
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Conversation_account_external_uq" ON "Conversation"("channelAccountId", "externalNumber") WHERE "contactId" IS NULL;
