-- RLS, passo 1: NEGAR POR PADRÃO (segurança, 01/10/2026).
--
-- No Supabase, toda tabela do schema `public` fica exposta na API de dados (PostgREST) para os
-- papéis `anon` e `authenticated`. Sem RLS, quem tem a chave pública do projeto lê e grava tudo.
-- Este passo fecha isso sem mudar nada para o app:
--   1. liga o RLS em TODA tabela de `public` (sem política = ninguém passa, a não ser o dono);
--   2. tira de `anon` e `authenticated` qualquer privilégio sobre tabelas e sequências.
-- O app conecta como dono das tabelas (papel `postgres`), e o dono NÃO é barrado pelo RLS (não usamos
-- FORCE ROW LEVEL SECURITY), então o comportamento do app não muda. O papel `service_role` do Supabase
-- tem BYPASSRLS de propósito e a chave dele nunca vai ao navegador.
-- As políticas por time (papel `crmagro_app`) vêm na migration seguinte.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tableowner = current_user
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

DO $$
DECLARE
  papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', papel);
    END IF;
  END LOOP;
END $$;
