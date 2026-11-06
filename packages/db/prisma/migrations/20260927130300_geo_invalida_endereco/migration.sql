-- Mapa (produto §B.2): endereço mudou → a coordenada ficou velha.
--
-- Em vez de enfileirar a geocodificação em cada caminho que grava endereço
-- (writeContact, edição, merge, empresas, importação, IA, enriquecimento… e os
-- que vierem), o banco zera o geoHash e o backfill da fila `geo` (worker, a
-- cada 30 s) geocodifica de novo. Cobre todos os caminhos, inclusive SQL
-- direto. Coordenada `manual` nunca é tocada. Os UPDATEs levam o teamId da
-- própria linha (nada cruza time).
-- O Prisma não modela trigger: não gera drift nos próximos `migrate diff`.

-- Contato: mudou endereço, cidade ou UF.
CREATE OR REPLACE FUNCTION crmagro_geo_invalida_contato() RETURNS trigger AS $$
BEGIN
  IF NEW."geoPrecisao" IS DISTINCT FROM 'manual' THEN
    NEW."geoHash" := NULL;
    NEW."geoAtualizadoEm" := NULL;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Contact_geo_invalida" ON "Contact";
CREATE TRIGGER "Contact_geo_invalida"
  BEFORE UPDATE OF "endereco", "cidade", "estado" ON "Contact"
  FOR EACH ROW
  WHEN (OLD."endereco" IS DISTINCT FROM NEW."endereco"
     OR OLD."cidade" IS DISTINCT FROM NEW."cidade"
     OR OLD."estado" IS DISTINCT FROM NEW."estado")
  EXECUTE FUNCTION crmagro_geo_invalida_contato();

-- Empresa: mudou endereço, cidade ou UF → ela e os contatos que HERDAM a
-- coordenada dela (sem endereço próprio: geoFonte 'empresa' ou 'nenhuma').
CREATE OR REPLACE FUNCTION crmagro_geo_invalida_empresa() RETURNS trigger AS $$
BEGIN
  IF NEW."geoPrecisao" IS DISTINCT FROM 'manual' THEN
    NEW."geoHash" := NULL;
    NEW."geoAtualizadoEm" := NULL;
  END IF;
  UPDATE "Contact" SET "geoHash" = NULL, "geoAtualizadoEm" = NULL
   WHERE "teamId" = NEW."teamId"
     AND ("geoFonte" = 'empresa' OR "geoPrecisao" = 'nenhuma')
     AND id IN (SELECT "contactId" FROM "ContactCompany" WHERE "companyId" = NEW.id AND "teamId" = NEW."teamId");
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Company_geo_invalida" ON "Company";
CREATE TRIGGER "Company_geo_invalida"
  BEFORE UPDATE OF "endereco", "cidade", "estado" ON "Company"
  FOR EACH ROW
  WHEN (OLD."endereco" IS DISTINCT FROM NEW."endereco"
     OR OLD."cidade" IS DISTINCT FROM NEW."cidade"
     OR OLD."estado" IS DISTINCT FROM NEW."estado")
  EXECUTE FUNCTION crmagro_geo_invalida_empresa();

-- Vínculo contato↔empresa criado ou desfeito: o contato sem endereço próprio
-- passa a herdar de outra empresa (ou de nenhuma).
CREATE OR REPLACE FUNCTION crmagro_geo_invalida_vinculo() RETURNS trigger AS $$
DECLARE
  v_contato TEXT;
  v_time TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_contato := OLD."contactId";
    v_time := OLD."teamId";
  ELSE
    v_contato := NEW."contactId";
    v_time := NEW."teamId";
  END IF;
  UPDATE "Contact" SET "geoHash" = NULL, "geoAtualizadoEm" = NULL
   WHERE id = v_contato AND "teamId" = v_time
     AND ("geoFonte" = 'empresa' OR "geoPrecisao" = 'nenhuma');
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ContactCompany_geo_invalida" ON "ContactCompany";
CREATE TRIGGER "ContactCompany_geo_invalida"
  AFTER INSERT OR DELETE ON "ContactCompany"
  FOR EACH ROW
  EXECUTE FUNCTION crmagro_geo_invalida_vinculo();
