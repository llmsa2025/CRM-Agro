-- Papel `evolution` e schema `evolution_api`: o banco do servidor do WhatsApp (Evolution API) passa a morar no
-- MESMO projeto Supabase do CRM Agro, em schema próprio, em vez de num Postgres em Docker no VPS.
--
-- Por quê: o VPS vira descartável. Hoje as sessões pareadas do WhatsApp e o histórico da Evolution vivem num
-- volume do Docker; se o VPS morrer, o número precisa ser pareado de novo. No Supabase elas ficam com o resto
-- do banco de produção (e entram no backup do projeto).
--
-- Isolamento: o papel só enxerga o schema `evolution_api`. Não tem nenhum privilégio nas tabelas do CRM Agro
-- (schema `public`), e o `crmagro_sistema` (app e worker) não tem nenhum no `evolution_api`.
--
-- O schema fica de propriedade de quem roda a migration (o dono), e o papel recebe USAGE e CREATE nele: as
-- tabelas que a Evolution criar (`prisma migrate deploy` dela) ou que o restauro trouxer nascem do papel. Não se
-- usa AUTHORIZATION nem OWNER TO porque no Postgres 17 quem cria o papel recebe ADMIN mas não SET, e o `postgres`
-- do Supabase seria barrado.
--
-- O papel nasce SEM login: a senha nunca entra em migration versionada. Quem liga o login é o dono, no editor
-- SQL do Supabase (`ALTER ROLE evolution LOGIN PASSWORD '...'`), com a senha que o
-- `script de operação preparar` gera. Roteiro: a documentação interna.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evolution') THEN
    CREATE ROLE evolution NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS evolution_api;
REVOKE ALL ON SCHEMA evolution_api FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA evolution_api TO evolution;

-- A Evolution manda `?schema=evolution_api` na conexão; o search_path do papel garante o mesmo para o pg_restore
-- e para qualquer cliente que esqueça o parâmetro.
ALTER ROLE evolution SET search_path = evolution_api;
