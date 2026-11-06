-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "statusAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Message_providerMessageId_idx" ON "Message"("providerMessageId");

-- CreateIndex
CREATE INDEX "Message_teamId_direcao_status_createdAt_idx" ON "Message"("teamId", "direcao", "status", "createdAt");
