-- Baseline retroativo: estas mudanças já estavam NO BANCO (aplicadas via
-- `db push` durante o Passo 8.5/9) mas nunca viraram migration. Sem este
-- arquivo, reconstruir o banco a partir das migrations gera um schema SEM
-- FlowStepExecution e o worker do motor de fluxos quebra.
-- Registrada com `migrate resolve --applied` (não re-executada).

-- CreateEnum
CREATE TYPE "FlowStepExecutionStatus" AS ENUM ('running', 'done', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalName" TEXT,
ADD COLUMN     "externalNumber" TEXT,
ALTER COLUMN "contactId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "lastOutboundAt" TIMESTAMP(3),
ADD COLUMN     "stepNumber" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "FlowStepExecution" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "jobId" TEXT,
    "status" "FlowStepExecutionStatus" NOT NULL DEFAULT 'running',
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FlowStepExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowStepExecution_teamId_idx" ON "FlowStepExecution"("teamId");

-- CreateIndex
CREATE INDEX "FlowStepExecution_enrollmentId_idx" ON "FlowStepExecution"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowStepExecution_enrollmentId_nodeId_round_key" ON "FlowStepExecution"("enrollmentId", "nodeId", "round");

-- CreateIndex
CREATE INDEX "Conversation_teamId_channelAccountId_externalNumber_idx" ON "Conversation"("teamId", "channelAccountId", "externalNumber");

-- AddForeignKey
ALTER TABLE "FlowStepExecution" ADD CONSTRAINT "FlowStepExecution_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowStepExecution" ADD CONSTRAINT "FlowStepExecution_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

