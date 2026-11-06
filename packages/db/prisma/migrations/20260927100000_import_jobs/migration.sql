-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('queued', 'processing', 'done', 'failed', 'canceled');

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'queued',
    "nomeArquivo" TEXT NOT NULL,
    "arquivoPath" TEXT,
    "mapeamento" JSONB NOT NULL,
    "opcoes" JSONB NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processadas" INTEGER NOT NULL DEFAULT 0,
    "criadas" INTEGER NOT NULL DEFAULT 0,
    "atualizadas" INTEGER NOT NULL DEFAULT 0,
    "puladas" INTEGER NOT NULL DEFAULT 0,
    "invalidas" INTEGER NOT NULL DEFAULT 0,
    "erros" JSONB,
    "createdById" TEXT,
    "iniciadoEm" TIMESTAMP(3),
    "concluidoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_teamId_createdAt_idx" ON "ImportJob"("teamId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

