-- CreateTable
CREATE TABLE "TeamConfig" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "respectBusinessHours" BOOLEAN NOT NULL DEFAULT false,
    "businessHourStart" TEXT NOT NULL DEFAULT '08:00',
    "businessHourEnd" TEXT NOT NULL DEFAULT '18:00',
    "businessDays" TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
    "respectHolidays" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamConfig_teamId_key" ON "TeamConfig"("teamId");

-- AddForeignKey
ALTER TABLE "TeamConfig" ADD CONSTRAINT "TeamConfig_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
