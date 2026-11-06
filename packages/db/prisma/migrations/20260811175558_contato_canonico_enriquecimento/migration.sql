-- Contato canônico + enriquecimento versionado (Fase B).
-- Aditivo e idempotente (IF NOT EXISTS) — nunca dropa nada. Aplicado na base de
-- TESTE via `prisma db execute`

-- Contact: classificação de PRODUTOR RURAL (colunas dedicadas = filtro indexável).
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "isProdutor" BOOLEAN;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "produtorScore" INTEGER;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "produtorLabel" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "produtorRegraVersao" TEXT;
CREATE INDEX IF NOT EXISTS "Contact_teamId_produtorLabel_idx" ON "Contact"("teamId", "produtorLabel");

-- Company: CNAE principal + secundários + tipos de IE (antes descartados no fetch).
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "cnae" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "cnaesSecundarios" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "iesTipos" JSONB;

-- EnrichmentFact: proveniência append-only do pipeline de enriquecimento.
CREATE TABLE IF NOT EXISTS "EnrichmentFact" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "enricherKey" TEXT NOT NULL,
    "enricherVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidences" JSONB,
    "producedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    CONSTRAINT "EnrichmentFact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EnrichmentFact_teamId_idx" ON "EnrichmentFact"("teamId");
CREATE INDEX IF NOT EXISTS "EnrichmentFact_teamId_targetType_targetId_idx" ON "EnrichmentFact"("teamId", "targetType", "targetId");
CREATE INDEX IF NOT EXISTS "EnrichmentFact_teamId_enricherKey_idx" ON "EnrichmentFact"("teamId", "enricherKey");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EnrichmentFact_teamId_fkey'
  ) THEN
    ALTER TABLE "EnrichmentFact"
      ADD CONSTRAINT "EnrichmentFact_teamId_fkey"
      FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
