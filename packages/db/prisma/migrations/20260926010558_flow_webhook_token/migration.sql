-- Item 0.6 (auditoria S5): token do webhook de fluxo em coluna própria, único.

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN     "webhookToken" TEXT;

-- Backfill: o token que hoje vive em triggerConfig.webhookToken. Se o MESMO
-- token estiver em dois fluxos (o sequestro que este item fecha), só o fluxo
-- mais antigo fica com ele; o outro fica NULL e ganha um token novo do servidor
-- no próximo salvamento. Conferir com:
--   SELECT id, "teamId", nome FROM "Flow"
--   WHERE "triggerConfig"->>'webhookToken' IS NOT NULL AND "webhookToken" IS NULL;
UPDATE "Flow" f
SET "webhookToken" = f."triggerConfig"->>'webhookToken'
WHERE f."triggerConfig"->>'webhookToken' IS NOT NULL
  AND f."triggerConfig"->>'webhookToken' <> ''
  AND f.id = (
    SELECT f2.id FROM "Flow" f2
    WHERE f2."triggerConfig"->>'webhookToken' = f."triggerConfig"->>'webhookToken'
    ORDER BY f2."createdAt" ASC, f2.id ASC
    LIMIT 1
  );

-- CreateIndex (tabela pequena: índice normal, sem CONCURRENTLY)
CREATE UNIQUE INDEX "Flow_webhookToken_key" ON "Flow"("webhookToken");
