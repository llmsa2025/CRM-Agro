-- Item 2.1: busca "contém" por trigram (ILIKE '%x%' usa índice GIN).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
