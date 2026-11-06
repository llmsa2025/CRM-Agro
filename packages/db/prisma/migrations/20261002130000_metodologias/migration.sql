-- Metodologias de abordagem da IA (Integrações → IA → Metodologias). Aditiva: tabela nova e uma coluna com padrão.
ALTER TABLE "Team" ADD COLUMN "metodologiasIniciadas" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Methodology" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "finalidade" TEXT NOT NULL,
    "descricao" TEXT,
    "conteudo" TEXT NOT NULL,
    "padrao" BOOLEAN NOT NULL DEFAULT false,
    "modelo" TEXT,
    "criadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Methodology_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Methodology_teamId_finalidade_idx" ON "Methodology"("teamId", "finalidade");

-- No máximo UMA metodologia padrão por time e finalidade (a regra mora no banco, não só no serviço).
CREATE UNIQUE INDEX "Methodology_um_padrao" ON "Methodology"("teamId", "finalidade") WHERE "padrao";

ALTER TABLE "Methodology" ADD CONSTRAINT "Methodology_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tabela com teamId nasce com a política por time.
ALTER TABLE "Methodology" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_por_time ON "Methodology";
CREATE POLICY isolamento_por_time ON "Methodology" FOR ALL TO crmagro_app
  USING ("teamId" = (SELECT current_setting('app.team_id', true)))
  WITH CHECK ("teamId" = (SELECT current_setting('app.team_id', true)));
