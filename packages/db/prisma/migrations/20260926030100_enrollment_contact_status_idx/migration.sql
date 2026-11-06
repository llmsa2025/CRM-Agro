-- Item 0.9: inscrições de um contato por status (trava de reinscrição, varredura).
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
-- Nome igual ao que o Prisma gera para @@index([contactId, status]).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Enrollment_contactId_status_idx" ON "Enrollment"("contactId", "status");
