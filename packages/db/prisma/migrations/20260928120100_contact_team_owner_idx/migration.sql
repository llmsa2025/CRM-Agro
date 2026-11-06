-- Escopo por dono (F3): lista de contatos "só os meus" sem varrer a tabela.
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_teamId_ownerId_idx" ON "Contact"("teamId", "ownerId");
