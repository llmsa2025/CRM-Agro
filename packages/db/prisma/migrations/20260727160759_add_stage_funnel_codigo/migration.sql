-- Código estável em Funnel e Stage (referência das automações).

-- AlterTable
ALTER TABLE "Funnel" ADD COLUMN "codigo" TEXT;
-- AlterTable
ALTER TABLE "Stage" ADD COLUMN "codigo" TEXT;

-- Backfill das rows existentes: código derivado do id (8 hex), determinístico e
-- único dentro do escopo (time / funil). Novas rows recebem código na criação.
UPDATE "Funnel" SET "codigo" = 'fnl_' || substr(replace("id"::text, '-', ''), 1, 8) WHERE "codigo" IS NULL;
UPDATE "Stage"  SET "codigo" = 'stg_' || substr(replace("id"::text, '-', ''), 1, 8) WHERE "codigo" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Funnel_teamId_codigo_key" ON "Funnel"("teamId", "codigo");
-- CreateIndex
CREATE UNIQUE INDEX "Stage_funnelId_codigo_key" ON "Stage"("funnelId", "codigo");
