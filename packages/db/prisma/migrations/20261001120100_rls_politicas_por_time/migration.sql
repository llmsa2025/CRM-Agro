-- RLS, passo 2: POLÍTICAS POR TIME para o papel `crmagro_app` (segurança, 01/10/2026).
--
-- `crmagro_app` é o papel que o app passa a usar quando `DATABASE_URL_APP` está configurada (ver
-- a documentação interna). Ele NÃO é dono das tabelas e NÃO tem BYPASSRLS, então o Postgres só mostra
-- a ele as linhas do time que a transação declarou:
--     SELECT set_config('app.team_id', '<id do time>', true);   -- true = vale só nesta transação
-- Sem esse valor a condição dá NULL e nenhuma linha passa (fecha por padrão, nunca "todos").
-- O papel nasce sem login: quem liga é o script script de operação, que define a senha
-- (senha nunca entra em migration versionada).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmagro_app') THEN
    CREATE ROLE crmagro_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO crmagro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crmagro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crmagro_app;
-- Tabela criada por migration futura já nasce acessível ao papel; o RLS (e o teste de guarda em
-- core/tenancy/rls.test.ts) é que decide o que ele enxerga.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crmagro_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crmagro_app;

-- 1) Toda tabela com a coluna "teamId": só as linhas do time da transação, para ler e para gravar
--    (WITH CHECK impede inserir ou mover linha para outro time).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'teamId'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS isolamento_por_time ON public.%I', t.table_name);
    EXECUTE format(
      'CREATE POLICY isolamento_por_time ON public.%I FOR ALL TO crmagro_app '
      || 'USING ("teamId" = (SELECT current_setting(''app.team_id'', true))) '
      || 'WITH CHECK ("teamId" = (SELECT current_setting(''app.team_id'', true)))',
      t.table_name
    );
  END LOOP;
END $$;

-- 2) Team: a raiz do tenant. O papel lê e atualiza só o próprio time; criar e apagar time é coisa do
--    cadastro e da operação, que usam o papel dono (nunca o crmagro_app).
DROP POLICY IF EXISTS time_proprio_leitura ON "Team";
CREATE POLICY time_proprio_leitura ON "Team" FOR SELECT TO crmagro_app
  USING ("id" = (SELECT current_setting('app.team_id', true)));
DROP POLICY IF EXISTS time_proprio_edicao ON "Team";
CREATE POLICY time_proprio_edicao ON "Team" FOR UPDATE TO crmagro_app
  USING ("id" = (SELECT current_setting('app.team_id', true)))
  WITH CHECK ("id" = (SELECT current_setting('app.team_id', true)));
REVOKE INSERT, DELETE ON "Team" FROM crmagro_app;

-- 3) Tabelas globais (sem time): cache de número com WhatsApp e de geocodificação, e a lista de
--    municípios do IBGE (só leitura; quem grava é o seed, pelo papel dono).
DROP POLICY IF EXISTS global_todos ON "WhatsAppNumberCheck";
CREATE POLICY global_todos ON "WhatsAppNumberCheck" FOR ALL TO crmagro_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS global_todos ON "GeoCache";
CREATE POLICY global_todos ON "GeoCache" FOR ALL TO crmagro_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS global_leitura ON "Municipio";
CREATE POLICY global_leitura ON "Municipio" FOR SELECT TO crmagro_app USING (true);
REVOKE INSERT, UPDATE, DELETE ON "Municipio" FROM crmagro_app;

-- 4) Tabelas que o app só toca pelo papel dono (login, cadastro, troca de senha): sem política E sem
--    privilégio para o crmagro_app, dupla trava.
REVOKE ALL ON "PasswordResetToken", "CadastroPendente", "_prisma_migrations" FROM crmagro_app;
