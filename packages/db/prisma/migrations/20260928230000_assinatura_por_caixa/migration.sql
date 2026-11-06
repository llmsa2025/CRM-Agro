-- Assinatura de e-mail POR CAIXA (ajuste do dono, 28/09/2026): o dono pode ter
-- 2 caixas, cada uma com as suas assinaturas e a sua padrão. Coluna nula e
-- índice novo: só metadado + um índice pequeno (tabela de poucas linhas).

-- AlterTable
ALTER TABLE "EmailSignature" ADD COLUMN     "channelAccountId" TEXT;

-- CreateIndex
CREATE INDEX "EmailSignature_channelAccountId_idx" ON "EmailSignature"("channelAccountId");

-- AddForeignKey
ALTER TABLE "EmailSignature" ADD CONSTRAINT "EmailSignature_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dados: até aqui a assinatura era do TIME; agora é da CAIXA. Ninguém perde a
-- assinatura que usava:
--   1) cada assinatura antiga ganha uma CÓPIA em cada caixa de e-mail do time,
--      menos a mais antiga (a cópia herda nome, conteúdo e "padrão");
--   2) a original vai para a caixa mais antiga do time — mantém o id, que os
--      passos de fluxo já guardam.
-- Time sem caixa de e-mail: a assinatura fica sem caixa (nula) e a primeira
-- caixa conectada a adota (connectEmailAccount). Só mexe em assinatura ainda
-- sem caixa, então rodar de novo não duplica nada.
INSERT INTO "EmailSignature" ("id", "teamId", "channelAccountId", "nome", "html", "isDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, s."teamId", c."id", s."nome", s."html", s."isDefault", s."createdAt", CURRENT_TIMESTAMP
FROM "EmailSignature" s
JOIN "ChannelAccount" c ON c."teamId" = s."teamId" AND c."canal" = 'email'
WHERE s."channelAccountId" IS NULL
  AND c."id" <> (
    SELECT c1."id" FROM "ChannelAccount" c1
    WHERE c1."teamId" = s."teamId" AND c1."canal" = 'email'
    ORDER BY c1."createdAt" ASC, c1."id" ASC
    LIMIT 1
  );

UPDATE "EmailSignature" s
SET "channelAccountId" = (
  SELECT c1."id" FROM "ChannelAccount" c1
  WHERE c1."teamId" = s."teamId" AND c1."canal" = 'email'
  ORDER BY c1."createdAt" ASC, c1."id" ASC
  LIMIT 1
)
WHERE s."channelAccountId" IS NULL;
