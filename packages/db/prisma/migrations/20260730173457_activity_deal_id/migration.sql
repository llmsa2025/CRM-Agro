-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "dealId" TEXT;

-- CreateIndex
CREATE INDEX "Activity_dealId_idx" ON "Activity"("dealId");
