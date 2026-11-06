-- CreateEnum
CREATE TYPE "ChannelAccountStatus" AS ENUM ('connected', 'disconnected', 'error');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channelAccountId" TEXT;

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "canal" "Canal" NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials" JSONB,
    "status" "ChannelAccountStatus" NOT NULL DEFAULT 'disconnected',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelAccount_teamId_idx" ON "ChannelAccount"("teamId");

-- CreateIndex
CREATE INDEX "ChannelAccount_teamId_canal_idx" ON "ChannelAccount"("teamId", "canal");

-- CreateIndex
CREATE INDEX "Conversation_channelAccountId_idx" ON "Conversation"("channelAccountId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccount" ADD CONSTRAINT "ChannelAccount_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
