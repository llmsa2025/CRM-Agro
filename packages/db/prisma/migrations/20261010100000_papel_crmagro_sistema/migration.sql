-- Papel `crmagro_sistema` (F2 do plano de CI/CD, 07/10/2026): o papel que o app e o worker passam a usar no lugar
-- do dono do banco (`postgres`).
--
-- Para que serve: tirar da VPS (e da Vercel) a credencial que pode APAGAR o banco. O dono (`postgres`) fica só
-- nos secrets do ambiente `producao` do GitHub, e só o workflow "Migrar banco" o usa. O app conecta como
-- `crmagro_sistema`: lê e grava dados (é o que ele faz hoje), mas não consegue DROP, TRUNCATE, ALTER, CREATE,
-- desligar RLS, criar ou trocar papel, nem ESCREVER no histórico de migrations (só lê).
--
-- Por que BYPASSRLS: o app de hoje usa o dono (`basePrisma`) para login, cadastro, alertas e as
-- varreduras do worker, que enxergam todos os times. O dono não é barrado pelo RLS por ser dono; o
-- `crmagro_sistema` não é dono, então precisa do atributo para continuar vendo o que o app já vê.
-- O isolamento por time (papel `crmagro_app`) continua sendo outra camada, independente desta.
--
-- O papel nasce SEM login: a senha nunca entra em migration versionada. Quem liga o login é o script
-- script de operação (ou um `ALTER ROLE crmagro_sistema LOGIN PASSWORD ...` do dono no Supabase).
-- Docs: a documentação interna.
--
-- Tabela criada por migration futura já nasce acessível ao papel (ALTER DEFAULT PRIVILEGES). Uma tabela
-- sem esse privilégio quebra o teste core/tenancy/papel-sistema.test.ts, de propósito.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmagro_sistema') THEN
    CREATE ROLE crmagro_sistema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO crmagro_sistema;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crmagro_sistema;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crmagro_sistema;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crmagro_sistema;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crmagro_sistema;

-- O que o papel NUNCA tem (sem TRUNCATE, REFERENCES nem TRIGGER nos GRANTs acima; os dois REVOKEs abaixo
-- fecham o resto):
--  1) o histórico de migrations é SÓ LEITURA para ele: o deploy.sh confere se há migration pendente
--     (`prisma migrate status`) e o pg_dump do backup leva a tabela junto. Escrever nele é do dono e do
--     workflow de migração;
--  2) criar objeto no schema public (bancos antigos do Supabase ainda herdam CREATE de PUBLIC).
REVOKE INSERT, UPDATE, DELETE ON TABLE "_prisma_migrations" FROM crmagro_sistema;
REVOKE CREATE ON SCHEMA public FROM crmagro_sistema;
