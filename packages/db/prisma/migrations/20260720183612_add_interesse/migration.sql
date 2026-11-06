-- CreateEnum
CREATE TYPE "Interesse" AS ENUM ('nao_avaliado', 'interessado', 'sem_interesse', 'talvez');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "interesse" "Interesse" NOT NULL DEFAULT 'nao_avaliado';

-- CreateIndex
CREATE INDEX "Contact_teamId_interesse_idx" ON "Contact"("teamId", "interesse");
