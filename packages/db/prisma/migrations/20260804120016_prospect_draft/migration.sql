-- CreateTable
CREATE TABLE "ProspectDraft" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "lote" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "empresa" TEXT,
    "cnpj" TEXT,
    "telefone" TEXT,
    "email" TEXT,
    "cidade" TEXT,
    "uf" TEXT,
    "cnae" TEXT,
    "extra" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pendente',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProspectDraft_teamId_origem_status_idx" ON "ProspectDraft"("teamId", "origem", "status");

-- CreateIndex
CREATE INDEX "ProspectDraft_teamId_lote_idx" ON "ProspectDraft"("teamId", "lote");

-- AddForeignKey
ALTER TABLE "ProspectDraft" ADD CONSTRAINT "ProspectDraft_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
