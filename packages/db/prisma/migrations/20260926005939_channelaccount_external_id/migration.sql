-- Item 0.5 (auditoria S4/INT-18, DP-04): instância WhatsApp amarrada a UMA conta.

-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "externalId" TEXT;

-- Backfill: a instância da Evolution (credentials.instance, JSON em texto puro
-- para provider=evolution) vira o externalId. Se a MESMA instância estiver em
-- duas contas (o bug que este item fecha), só a mais antiga recebe; as outras
-- ficam NULL — conferir depois com:
--   SELECT id, "teamId", label, credentials->>'instance' FROM "ChannelAccount"
--   WHERE provider = 'evolution' AND "externalId" IS NULL;
UPDATE "ChannelAccount" c
SET "externalId" = c.credentials->>'instance'
WHERE c.provider = 'evolution'
  AND c."externalId" IS NULL
  AND c.credentials->>'instance' IS NOT NULL
  AND c.id = (
    SELECT c2.id FROM "ChannelAccount" c2
    WHERE c2.provider = 'evolution'
      AND c2.credentials->>'instance' = c.credentials->>'instance'
    ORDER BY c2."createdAt" ASC, c2.id ASC
    LIMIT 1
  );

-- CreateIndex (tabela pequena: índice normal, sem CONCURRENTLY)
CREATE UNIQUE INDEX "ChannelAccount_provider_externalId_key" ON "ChannelAccount"("provider", "externalId");
