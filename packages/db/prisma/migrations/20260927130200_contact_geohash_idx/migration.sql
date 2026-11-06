-- Mapa (produto §B.2): o backfill da geocodificação procura "geoHash IS NULL"
-- (contato nunca processado) sem varrer a tabela.
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
-- Nome igual ao que o Prisma gera para @@index([geoHash]).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_geoHash_idx" ON "Contact"("geoHash");
