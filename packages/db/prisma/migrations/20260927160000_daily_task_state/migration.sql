-- CreateTable
CREATE TABLE "DailyTaskState" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "feitoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyTaskState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyTaskState_feitoEm_idx" ON "DailyTaskState"("feitoEm");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTaskState_teamId_userId_chave_key" ON "DailyTaskState"("teamId", "userId", "chave");

-- AddForeignKey
ALTER TABLE "DailyTaskState" ADD CONSTRAINT "DailyTaskState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyTaskState" ADD CONSTRAINT "DailyTaskState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

