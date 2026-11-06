-- Cifra em repouso de e-mail e telefone dos contatos. ADITIVA e inócua:
-- só colunas anuláveis e índices novos. Com a flag CONTATOS_CIFRA=off (padrão) nada as preenche e o
-- código antigo nem as enxerga. Nenhum dado existente é lido, movido nem apagado.
--
-- Risco: CREATE INDEX (sem CONCURRENTLY, porque o Prisma roda o arquivo numa transação) segura as escritas
-- da tabela por instantes enquanto o índice nasce. As colunas novas estão todas NULL, então o índice é
-- construído quase sem trabalho; ChannelIdentifier/Conversation têm dezenas de milhares de linhas, não milhões.
-- Desfazer (sem perda de dado nenhum):
--   DROP INDEX "ChannelIdentifier_teamId_canal_valorHash_key", "ChannelIdentifier_teamId_valorSufixoHash_idx",
--     "Conversation_teamId_channelAccountId_externalNumberHash_idx", "Conversation_teamId_externalNumberHash_idx",
--     "Conversation_account_external_hash_uq", "WhatsAppLid_teamId_telefoneHash_idx";
--   ALTER TABLE "ChannelIdentifier" DROP COLUMN "valorCifrado", DROP COLUMN "valorHash", DROP COLUMN "valorSufixoHash";
--   ALTER TABLE "Conversation" DROP COLUMN "externalNumberCifrado", DROP COLUMN "externalNumberHash";
--   ALTER TABLE "WhatsAppLid" DROP COLUMN "telefoneCifrado", DROP COLUMN "telefoneHash";
--   ALTER TABLE "Call" DROP COLUMN "phoneNumberCifrado";
--   ALTER TABLE "CampaignRecipient" DROP COLUMN "telefoneCifrado";

ALTER TABLE "ChannelIdentifier" ADD COLUMN "valorCifrado" TEXT, ADD COLUMN "valorHash" TEXT, ADD COLUMN "valorSufixoHash" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "externalNumberCifrado" TEXT, ADD COLUMN "externalNumberHash" TEXT;
ALTER TABLE "WhatsAppLid" ADD COLUMN "telefoneCifrado" TEXT, ADD COLUMN "telefoneHash" TEXT;
ALTER TABLE "Call" ADD COLUMN "phoneNumberCifrado" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "telefoneCifrado" TEXT;

-- O unique do índice cego (NULL é distinto no Postgres: nenhuma linha antiga colide).
CREATE UNIQUE INDEX "ChannelIdentifier_teamId_canal_valorHash_key" ON "ChannelIdentifier"("teamId", "canal", "valorHash");
-- Índice parcial do sufixo de 8 dígitos (Duplicados e busca de número sem DDD). Só SQL (o Prisma não expressa WHERE).
CREATE INDEX "ChannelIdentifier_teamId_valorSufixoHash_idx" ON "ChannelIdentifier"("teamId", "valorSufixoHash") WHERE "valorSufixoHash" IS NOT NULL;

CREATE INDEX "Conversation_teamId_channelAccountId_externalNumberHash_idx" ON "Conversation"("teamId", "channelAccountId", "externalNumberHash");
CREATE INDEX "Conversation_teamId_externalNumberHash_idx" ON "Conversation"("teamId", "externalNumberHash");
-- O parcial único das conversas soltas, agora pelo índice cego. O antigo (pelo texto) continua e cobre @lid e legado.
-- Só SQL (WHERE).
CREATE UNIQUE INDEX "Conversation_account_external_hash_uq" ON "Conversation"("channelAccountId", "externalNumberHash") WHERE "contactId" IS NULL AND "externalNumberHash" IS NOT NULL;

CREATE INDEX "WhatsAppLid_teamId_telefoneHash_idx" ON "WhatsAppLid"("teamId", "telefoneHash");
