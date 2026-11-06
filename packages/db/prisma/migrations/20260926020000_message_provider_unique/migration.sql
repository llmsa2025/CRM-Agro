-- Item 0.8 (auditoria INT-02): Mensagem com o mesmo id do WhatsApp gravada 2× (entregas concorrentes, eco do fromMe).
-- Índice único PARCIAL — o schema.prisma não expressa (ver comentário no model).
-- ANTES em produção: node scripts/dedup-inbound.mjs --aplicar (senão o índice falha).
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Message_team_provider_uq" ON "Message"("teamId", "providerMessageId") WHERE "providerMessageId" IS NOT NULL;
