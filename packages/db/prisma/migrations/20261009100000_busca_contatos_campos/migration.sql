-- Busca de Contatos (PR 1: campos do contato e da empresa).
--
-- O campo de pesquisa da tela de Contatos passa a achar por QUALQUER dado da tela e da ficha, sem diferenciar
-- maiúscula nem acento ("jose" acha "José", "sao paulo" acha "São Paulo"). Para isso o Postgres compara um texto
-- JÁ normalizado e guardado na própria linha (coluna `buscaTexto`), com um índice trigram sobre ele:
--
--   1. funções IMUTÁVEIS de normalização (sem depender da extensão `unaccent`, que muda de schema entre
--      ambientes do Supabase);
--   2. `Contact.buscaTexto` e `Company.buscaTexto`: o "palheiro" de cada registro (nome, cidade, cargo, CNPJ só
--      em dígitos, sócios e razão social do enriquecimento etc.), mantido por TRIGGER em toda escrita, então
--      nenhum caminho de gravação (tela, importação, captação, motor) precisa lembrar de atualizá-lo;
--   3. um índice GIN (teamId + trigram) sobre cada palheiro: a busca "contém" é filtrada por time DENTRO do
--      índice (btree_gin) e a conferência final é um LIKE simples, sem recalcular a normalização por linha.
--
-- NÃO guarda e-mail, telefone nem CPF do contato no palheiro (a cifra CONTATOS_CIFRA depende disso): esses
-- ficam em ChannelIdentifier (busca cifrada) e Contact.cpfHash (igualdade exata). A busca FUNCIONA sem os
-- índices (só fica mais lenta) e a coluna é preenchida aqui mesmo (backfill), então a ordem de deploy não importa.
--
-- Custo (50 mil contatos e 90 mil empresas, banco local de 1 vCPU): backfill ~30 s, índices ~10 s. A migration roda
-- em transação (sem CONCURRENTLY) e segura escrita em Contact e Company durante esse tempo. Com a base atual
-- (poucos milhares de linhas) leva segundos. Detalhes e números: a documentação interna.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Texto sem acento e em minúsculas. Troca caractere por caractere (mesmo tamanho), então a posição de um
-- acerto no texto normalizado é a mesma do texto original (o destaque do trecho depende disso). As maiúsculas
-- acentuadas entram na tabela porque lower() de caractere não ASCII depende do locale do banco.
CREATE OR REPLACE FUNCTION crmagro_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT lower(translate(t,
    'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäåéèêëíìîïóòôõöúùûüçñ',
    'AAAAAAEEEEIIIIOOOOOUUUUCNaaaaaaeeeeiiiiooooouuuucn'))
$$;

-- Só os dígitos de um texto (CNPJ, IE, telefone: com ou sem máscara viram a mesma coisa).
CREATE OR REPLACE FUNCTION crmagro_digitos(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(t, '\D', '', 'g')
$$;

-- Palheiro do CONTATO: o que a tela e a ficha mostram da pessoa. Sem e-mail, telefone e CPF (ver cabeçalho).
CREATE OR REPLACE FUNCTION crmagro_busca_contato(
  nome text, sobrenome text, cidade text, estado text, endereco text, empresa text, cargo text,
  origem text, site text, cnpj text, tags text[], culturas text[]
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT crmagro_norm(
    coalesce(nome, '') || ' ' || coalesce(sobrenome, '') || ' ' || coalesce(cidade, '') || ' ' ||
    coalesce(estado, '') || ' ' || coalesce(endereco, '') || ' ' || coalesce(empresa, '') || ' ' ||
    coalesce(cargo, '') || ' ' || coalesce(origem, '') || ' ' || coalesce(site, '') || ' ' ||
    coalesce(array_to_string(tags, ' '), '') || ' ' || coalesce(array_to_string(culturas, ' '), '')
  ) || ' ' || coalesce(crmagro_digitos(cnpj), '')
$$;

-- Palheiro da EMPRESA: colunas da ficha (nome, CNPJ e IE só em dígitos, telefone só em dígitos, e-mail,
-- endereço...) + do enriquecimento: dados da Receita (razão social, nome fantasia, atividade, porte...) e sócios
-- (nome e qualificação). O resto do JSON (fontes, datas, confiança) fica de fora para não dar acerto falso.
CREATE OR REPLACE FUNCTION crmagro_busca_empresa(
  nome text, cnpj text, ie text, site text, email text, telefone text, endereco text, cidade text,
  estado text, instagram text, linkedin text, natureza text, enrichment jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT crmagro_norm(
    coalesce(nome, '') || ' ' || coalesce(site, '') || ' ' || coalesce(email, '') || ' ' ||
    coalesce(endereco, '') || ' ' || coalesce(cidade, '') || ' ' || coalesce(estado, '') || ' ' ||
    coalesce(instagram, '') || ' ' || coalesce(linkedin, '') || ' ' || coalesce(natureza, '') || ' ' ||
    coalesce(jsonb_path_query_array(enrichment, '$.publico[*].valor')::text, '') || ' ' ||
    coalesce(jsonb_path_query_array(enrichment, '$.socios[*].nome')::text, '') || ' ' ||
    coalesce(jsonb_path_query_array(enrichment, '$.socios[*].qualificacao')::text, '')
  ) || ' ' || coalesce(crmagro_digitos(cnpj), '') || ' ' || coalesce(crmagro_digitos(ie), '') || ' ' ||
    coalesce(crmagro_digitos(telefone), '')
$$;

-- Colunas (o Prisma as declara com @ignore: o app nunca lê nem grava; quem escreve é o trigger).
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "buscaTexto" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "buscaTexto" TEXT;

-- Triggers: recalculam o palheiro só quando muda uma coluna que entra nele (status, interesse e afins, que
-- mudam o tempo todo, não disparam nada).
CREATE OR REPLACE FUNCTION crmagro_contato_busca_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."buscaTexto" := crmagro_busca_contato(NEW.nome, NEW.sobrenome, NEW.cidade, NEW.estado, NEW.endereco, NEW.empresa,
                                          NEW.cargo, NEW.origem, NEW.site, NEW.cnpj, NEW.tags, NEW.culturas);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION crmagro_empresa_busca_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."buscaTexto" := crmagro_busca_empresa(NEW.nome, NEW.cnpj, NEW.ie, NEW.site, NEW.email, NEW.telefone, NEW.endereco,
                                          NEW.cidade, NEW.estado, NEW.instagram, NEW.linkedin, NEW."naturezaJuridica", NEW.enrichment);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Contact_busca_trg" ON "Contact";
CREATE TRIGGER "Contact_busca_trg"
  BEFORE INSERT OR UPDATE OF nome, sobrenome, cidade, estado, endereco, empresa, cargo, origem, site, cnpj, tags, culturas
  ON "Contact" FOR EACH ROW EXECUTE FUNCTION crmagro_contato_busca_trg();

DROP TRIGGER IF EXISTS "Company_busca_trg" ON "Company";
CREATE TRIGGER "Company_busca_trg"
  BEFORE INSERT OR UPDATE OF nome, cnpj, ie, site, email, telefone, endereco, cidade, estado, instagram, linkedin, "naturezaJuridica", enrichment
  ON "Company" FOR EACH ROW EXECUTE FUNCTION crmagro_empresa_busca_trg();

-- Backfill das linhas que já existem (os triggers só cuidam das próximas).
UPDATE "Contact" SET "buscaTexto" = crmagro_busca_contato(nome, sobrenome, cidade, estado, endereco, empresa, cargo, origem, site, cnpj, tags, culturas)
 WHERE "buscaTexto" IS NULL;
UPDATE "Company" SET "buscaTexto" = crmagro_busca_empresa(nome, cnpj, ie, site, email, telefone, endereco, cidade, estado, instagram, linkedin, "naturezaJuridica", enrichment)
 WHERE "buscaTexto" IS NULL;

-- Índices: o Prisma não expressa GIN com btree_gin, então vivem só no SQL (como os índices parciais já existentes).
CREATE INDEX IF NOT EXISTS "Contact_busca_idx" ON "Contact" USING gin ("teamId", "buscaTexto" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Company_busca_idx" ON "Company" USING gin ("teamId", "buscaTexto" gin_trgm_ops);
