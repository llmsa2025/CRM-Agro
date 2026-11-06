-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationTipo" ADD VALUE 'anthropic';
ALTER TYPE "IntegrationTipo" ADD VALUE 'openai';
ALTER TYPE "IntegrationTipo" ADD VALUE 'glm';

-- AlterTable
ALTER TABLE "TeamConfig" ADD COLUMN     "aiMode" TEXT NOT NULL DEFAULT 'off';
