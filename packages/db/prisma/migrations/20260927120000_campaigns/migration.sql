-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'sending', 'paused', 'done', 'canceled');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('queued', 'sending', 'held', 'skipped', 'sent', 'delivered', 'read', 'replied', 'opted_out', 'failed');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "etapa" INTEGER NOT NULL DEFAULT 1,
    "channelAccountId" TEXT,
    "listaOrigem" JSONB,
    "regraJaConversou" TEXT NOT NULL DEFAULT 'hold',
    "diasSemCampanha" INTEGER NOT NULL DEFAULT 30,
    "mensagem" TEXT,
    "variacoes" JSONB,
    "textoRetomada" TEXT,
    "limiteDiario" INTEGER,
    "janelaInicio" TEXT NOT NULL DEFAULT '08:30',
    "janelaFim" TEXT NOT NULL DEFAULT '17:30',
    "pausaAlmocoInicio" TEXT DEFAULT '11:30',
    "pausaAlmocoFim" TEXT DEFAULT '13:30',
    "intervaloMinS" INTEGER NOT NULL DEFAULT 60,
    "intervaloMaxS" INTEGER NOT NULL DEFAULT 180,
    "loteTamanho" INTEGER NOT NULL DEFAULT 20,
    "pausaLoteMinM" INTEGER NOT NULL DEFAULT 15,
    "pausaLoteMaxM" INTEGER NOT NULL DEFAULT 25,
    "freioSaidasPct" INTEGER NOT NULL DEFAULT 3,
    "freioFalhasSeq" INTEGER NOT NULL DEFAULT 5,
    "flowId" TEXT,
    "iniciaEm" TIMESTAMP(3),
    "terminoPrevisto" TIMESTAMP(3),
    "pausadoMotivo" TEXT,
    "tickToken" TEXT,
    "enviadosNoLote" INTEGER NOT NULL DEFAULT 0,
    "falhasSeguidas" INTEGER NOT NULL DEFAULT 0,
    "ultimoEnvioEm" TIMESTAMP(3),
    "iniciadaEm" TIMESTAMP(3),
    "concluidaEm" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'queued',
    "motivo" TEXT,
    "telefone" TEXT,
    "variacao" INTEGER,
    "reservadoEm" TIMESTAMP(3),
    "enviandoEm" TIMESTAMP(3),
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "messageId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "classificacao" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppNumberCheck" (
    "numero" TEXT NOT NULL,
    "existe" BOOLEAN NOT NULL,
    "jid" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppNumberCheck_pkey" PRIMARY KEY ("numero")
);

-- CreateIndex
CREATE INDEX "Campaign_teamId_status_idx" ON "Campaign"("teamId", "status");

-- CreateIndex
CREATE INDEX "Campaign_teamId_createdAt_idx" ON "Campaign"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Campaign_channelAccountId_idx" ON "Campaign"("channelAccountId");

-- CreateIndex
CREATE INDEX "Campaign_flowId_idx" ON "Campaign"("flowId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_status_createdAt_idx" ON "CampaignRecipient"("campaignId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_contactId_sentAt_idx" ON "CampaignRecipient"("contactId", "sentAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_teamId_providerMessageId_idx" ON "CampaignRecipient"("teamId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_contactId_key" ON "CampaignRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "WhatsAppNumberCheck_checkedAt_idx" ON "WhatsAppNumberCheck"("checkedAt");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

