-- Programa de segurança de outubro: token do webhook de fluxo guardado em HASH.
-- ADITIVA: não apaga nem altera "webhookToken" (texto puro). Quem apaga o texto é o script do dono
-- (script de operação), depois de um backup. Código antigo ignora as colunas novas.

-- AlterTable (coluna nula, sem DEFAULT: só metadado no Postgres 11+, o bloqueio dura milissegundos)
ALTER TABLE "Flow" ADD COLUMN     "webhookTokenGeradoEm" TIMESTAMP(3),
ADD COLUMN     "webhookTokenHash" TEXT;

-- Backfill: sha256 hex do token que já circula. As URLs distribuídas continuam valendo, porque o app
-- procura o fluxo pelo hash do MESMO texto. Igual a createHash('sha256').update(token).digest('hex')
-- do Node (os tokens são ASCII; UTF-8 nos dois lados). Idempotente. Não mexe em "updatedAt".
-- Conferir depois com:
--   SELECT count(*) FROM "Flow" WHERE "webhookToken" IS NOT NULL AND "webhookTokenHash" IS NULL;  -- 0
UPDATE "Flow"
SET "webhookTokenHash" = encode(sha256(convert_to("webhookToken", 'UTF8')), 'hex')
WHERE "webhookToken" IS NOT NULL
  AND "webhookToken" <> ''
  AND "webhookTokenHash" IS NULL;

-- CreateIndex (tabela pequena: índice normal, sem CONCURRENTLY, como na migration do token em texto)
CREATE UNIQUE INDEX "Flow_webhookTokenHash_key" ON "Flow"("webhookTokenHash");

-- Para desfazer (nada depende das colunas enquanto o código novo não estiver no ar):
--   DROP INDEX "Flow_webhookTokenHash_key";
--   ALTER TABLE "Flow" DROP COLUMN "webhookTokenHash", DROP COLUMN "webhookTokenGeradoEm";
