-- Busca de Contatos (PR 2: histórico do contato).
--
-- A busca da tela de Contatos passa a achar também por PALAVRAS do histórico: mensagens de conversa (WhatsApp e
-- e-mail, com o assunto), notas, e-mails e ligações registrados no histórico e a transcrição, o resumo e as
-- anotações das ligações. É busca por PALAVRA (dicionário `portuguese`: "fazendas" acha "fazenda"; o que se digita
-- vale como começo de palavra: "financ" acha "financiamento"), não por pedaço de texto.
--
-- Esta migration cria só o que é LEVE: as funções do texto de busca (a mesma chamada vai no índice e na consulta,
-- então uma mudança futura é nova função + novo índice) e, SE a tabela for pequena, os índices. Tabela grande NÃO
-- ganha índice aqui: o Prisma roda a migration em transação (sem CONCURRENTLY) e criar índice GIN em milhões de
-- mensagens seguraria a escrita (as mensagens que chegam pelo WhatsApp) durante toda a criação. Nesse caso a
-- migration só avisa e o índice sai pelo script de operação `script de operação` (CONCURRENTLY,
-- sem bloquear a escrita). A busca no histórico FUNCIONA sem os índices (varre as mensagens do time), só mais
-- devagar; e se demorar demais a tela mostra o resultado SEM o histórico, com um aviso.
--
-- Os índices são GIN (teamId + texto de busca): o time é filtrado dentro do índice, sem ler mensagem de outro time.
-- Medição e orientação: a documentação interna.

CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ATENÇÃO (Postgres 17): CREATE INDEX, ANALYZE e VACUUM rodam as funções do índice com search_path "seguro"
-- (só pg_catalog). Função de índice que chama OUTRA função nossa sem nome de schema quebra ali ("function
-- crmagro_tsv does not exist"). Por isso estas três levam `SET search_path FROM CURRENT` (o schema da migration):
-- cada uma enxerga as funções crmagro_* de qualquer contexto. Custo: não são "inlinadas", o que não pesa.

-- Texto -> tsvector: sem acento (crmagro_norm) e com o dicionário em português.
CREATE OR REPLACE FUNCTION crmagro_tsv(t text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS $$
  SELECT to_tsvector('portuguese'::regconfig, crmagro_norm(t))
$$;

-- Mensagem: o texto e, no e-mail, o assunto (guardado em meta->>'subject').
CREATE OR REPLACE FUNCTION crmagro_tsv_mensagem(conteudo text, meta jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS $$
  SELECT crmagro_tsv(coalesce(conteudo, '') || ' ' || coalesce(meta ->> 'subject', ''))
$$;

-- Ligação: transcrição, resumo e anotações do vendedor.
CREATE OR REPLACE FUNCTION crmagro_tsv_ligacao(transcript text, summary text, notes text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS $$
  SELECT crmagro_tsv(coalesce(transcript, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))
$$;

-- Índices só se a tabela é pequena (até 100 mil linhas; a contagem para em 100.001, então é barata).
DO $$
DECLARE
  n_msg bigint;
  n_ativ bigint;
  n_lig bigint;
BEGIN
  SELECT count(*) INTO n_msg FROM (SELECT 1 FROM "Message" LIMIT 100001) s;
  SELECT count(*) INTO n_ativ FROM (SELECT 1 FROM "Activity" LIMIT 100001) s;
  SELECT count(*) INTO n_lig FROM (SELECT 1 FROM "Call" LIMIT 100001) s;

  IF n_msg <= 100000 THEN
    CREATE INDEX IF NOT EXISTS "Message_busca_hist_idx" ON "Message" USING gin ("teamId", crmagro_tsv_mensagem("conteudo", "meta"));
  ELSE
    RAISE NOTICE 'Message tem mais de 100 mil linhas: indice de busca NAO criado. Crie o indice depois, fora do horario de uso (CREATE INDEX CONCURRENTLY).';
  END IF;

  IF n_ativ <= 100000 THEN
    CREATE INDEX IF NOT EXISTS "Activity_busca_hist_idx" ON "Activity" USING gin ("teamId", crmagro_tsv("conteudo")) WHERE "tipo" IN ('note', 'call', 'email');
  ELSE
    RAISE NOTICE 'Activity tem mais de 100 mil linhas: indice de busca NAO criado. Crie o indice depois, fora do horario de uso (CREATE INDEX CONCURRENTLY).';
  END IF;

  IF n_lig <= 100000 THEN
    CREATE INDEX IF NOT EXISTS "Call_busca_hist_idx" ON "Call" USING gin ("teamId", crmagro_tsv_ligacao("transcript", "summary", "notes"));
  ELSE
    RAISE NOTICE 'Call tem mais de 100 mil linhas: indice de busca NAO criado. Crie o indice depois, fora do horario de uso (CREATE INDEX CONCURRENTLY).';
  END IF;
END $$;
