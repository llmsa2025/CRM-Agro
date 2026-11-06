-- CreateTable
CREATE TABLE "EmailEncaminhamento" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "channelAccountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenCifrado" JSONB NOT NULL,
    "confirmacaoLink" JSONB,
    "confirmacaoEm" TIMESTAMP(3),
    "confirmadoEm" TIMESTAMP(3),
    "ultimoRecebidoEm" TIMESTAMP(3),
    "recusados" INTEGER NOT NULL DEFAULT 0,
    "ultimoRecusadoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailEncaminhamento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailEncaminhamento_channelAccountId_key" ON "EmailEncaminhamento"("channelAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEncaminhamento_tokenHash_key" ON "EmailEncaminhamento"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailEncaminhamento_teamId_idx" ON "EmailEncaminhamento"("teamId");

-- AddForeignKey
ALTER TABLE "EmailEncaminhamento" ADD CONSTRAINT "EmailEncaminhamento_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEncaminhamento" ADD CONSTRAINT "EmailEncaminhamento_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

