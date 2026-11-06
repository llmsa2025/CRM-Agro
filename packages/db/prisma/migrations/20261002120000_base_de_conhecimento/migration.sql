-- Base de conhecimento da empresa (Integrações → IA). Aditiva: tabela nova, nada existente muda.
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "fonte" TEXT NOT NULL,
    "nomeArquivo" TEXT,
    "linkOrigem" TEXT,
    "conteudo" TEXT NOT NULL,
    "caracteres" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeDoc_teamId_ativo_idx" ON "KnowledgeDoc"("teamId", "ativo");

ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tabela com teamId nasce com a política por time.
ALTER TABLE "KnowledgeDoc" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_por_time ON "KnowledgeDoc";
CREATE POLICY isolamento_por_time ON "KnowledgeDoc" FOR ALL TO crmagro_app
  USING ("teamId" = (SELECT current_setting('app.team_id', true)))
  WITH CHECK ("teamId" = (SELECT current_setting('app.team_id', true)));
