-- Agenda (produto §E): compromissos do responsável (rota do dia, lembrete).
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
-- Nome igual ao que o Prisma gera para @@index([responsavelId]).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Appointment_responsavelId_idx" ON "Appointment"("responsavelId");
