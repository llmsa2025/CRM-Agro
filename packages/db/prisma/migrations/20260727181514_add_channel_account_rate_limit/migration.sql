-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "dailyLimit" INTEGER,
ADD COLUMN     "paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warmupStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChannelAccountUsage" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "channelAccountId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccountUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelAccountUsage_teamId_idx" ON "ChannelAccountUsage"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccountUsage_channelAccountId_day_key" ON "ChannelAccountUsage"("channelAccountId", "day");

-- AddForeignKey
ALTER TABLE "ChannelAccountUsage" ADD CONSTRAINT "ChannelAccountUsage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccountUsage" ADD CONSTRAINT "ChannelAccountUsage_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

