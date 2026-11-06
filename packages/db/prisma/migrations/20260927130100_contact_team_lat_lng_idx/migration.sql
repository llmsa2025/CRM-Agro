-- Mapa (produto §B.3): pontos de um retângulo (bbox) do time.
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
-- Nome igual ao que o Prisma gera para @@index([teamId, latitude, longitude]).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_teamId_latitude_longitude_idx" ON "Contact"("teamId", "latitude", "longitude");
