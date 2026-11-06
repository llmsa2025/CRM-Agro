-- Fonte de dados paga por time (Integrações → Fontes de dados) e registro das consultas de dado de pessoa.
-- Aditiva: um valor novo no enum e uma tabela nova. Nada existente muda.
ALTER TYPE "IntegrationTipo" ADD VALUE IF NOT EXISTS 'cnpja';

-- Registro de consulta PAGA de nome, CPF ou IE (LGPD: quem, quando, por quê, em qual fonte, quanto custou).
-- O documento nunca fica em claro: só o HMAC por time e o mascarado, que a pedido do titular são apagados.
CREATE TABLE "ConsultaDocumento" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" TEXT NOT NULL,
    "documentoHmac" TEXT NOT NULL,
    "documentoMascarado" TEXT,
    "uf" TEXT,
    "motivo" TEXT,
    "fonte" TEXT NOT NULL,
    "creditos" INTEGER NOT NULL DEFAULT 0,
    "custoCentavos" INTEGER,
    "contactId" TEXT,

    CONSTRAINT "ConsultaDocumento_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsultaDocumento_teamId_criadoEm_idx" ON "ConsultaDocumento"("teamId", "criadoEm");
CREATE INDEX "ConsultaDocumento_teamId_fonte_criadoEm_idx" ON "ConsultaDocumento"("teamId", "fonte", "criadoEm");

ALTER TABLE "ConsultaDocumento" ADD CONSTRAINT "ConsultaDocumento_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tabela com teamId nasce com a política por time.
ALTER TABLE "ConsultaDocumento" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_por_time ON "ConsultaDocumento";
CREATE POLICY isolamento_por_time ON "ConsultaDocumento" FOR ALL TO crmagro_app
  USING ("teamId" = (SELECT current_setting('app.team_id', true)))
  WITH CHECK ("teamId" = (SELECT current_setting('app.team_id', true)));
