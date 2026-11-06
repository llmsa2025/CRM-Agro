-- Agenda (produto §E): o job agenda-lembrete (cruza times, a cada 1 min) busca
-- os pendentes numa janela de início.
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
-- Nome igual ao que o Prisma gera para @@index([status, inicio]).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Appointment_status_inicio_idx" ON "Appointment"("status", "inicio");
