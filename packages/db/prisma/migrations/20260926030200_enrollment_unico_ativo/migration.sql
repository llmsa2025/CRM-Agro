-- Item 0.9 (MF-04, INT-02.4): um contato percorre um fluxo UMA vez por vez.
-- Índice único PARCIAL — o schema.prisma não expressa (ver comentário no model).
-- ANTES em produção: node scripts/dedup-enrollments.mjs --aplicar (senão o índice falha).
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Enrollment_um_ativo" ON "Enrollment"("flowId", "contactId") WHERE status IN ('active', 'waiting');
