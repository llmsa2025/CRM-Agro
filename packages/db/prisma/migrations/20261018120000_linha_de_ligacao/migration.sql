-- F1B-05 (plano de ligação): LinhaDeLigacao, por onde um vendedor (ou o time) liga, e Call.linhaId.
-- Aditiva: uma tabela nova, uma coluna opcional em Call e uma FK que nasce sem conferir as linhas antigas.
-- Nada existente muda. A FK é conferida na migration seguinte e o índice de Call.linhaId na última,
-- porque Call é uma das maiores tabelas.
--
-- Call é tabela que já existe: o lock_timeout faz esta migration desistir em 5 s, sem alterar nada, se a
-- tabela estiver ocupada (o pooler do Supabase ignora o lock_timeout da conexão).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE "LinhaDeLigacao" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "provedor" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "contaExterna" TEXT NOT NULL,
    "idExterno" TEXT NOT NULL,
    "integrationId" TEXT,
    "userId" TEXT,
    "padrao" BOOLEAN NOT NULL DEFAULT false,
    "rotulo" TEXT,
    "numeroExibido" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'ativa',
    "motivoPausa" TEXT,
    "pausadaAte" TIMESTAMP(3),
    "credentials" JSONB,
    "webhookVersao" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinhaDeLigacao_pkey" PRIMARY KEY ("id")
);

-- A mesma linha do provedor não entra em dois times: o time sai da linha, nunca do corpo do aviso.
CREATE UNIQUE INDEX "LinhaDeLigacao_provedor_contaExterna_idExterno_key" ON "LinhaDeLigacao"("provedor", "contaExterna", "idExterno");

CREATE INDEX "LinhaDeLigacao_teamId_idx" ON "LinhaDeLigacao"("teamId");
CREATE INDEX "LinhaDeLigacao_teamId_userId_idx" ON "LinhaDeLigacao"("teamId", "userId");

-- Uma linha padrão por pessoa. Índice parcial: o Prisma não o expressa, então só existe aqui (e vem
-- comentado no schema.prisma). Linha do time (userId nulo) não entra: NULL é sempre distinto no índice.
CREATE UNIQUE INDEX "LinhaDeLigacao_teamId_userId_padrao_key" ON "LinhaDeLigacao"("teamId", "userId") WHERE "padrao";

ALTER TABLE "LinhaDeLigacao" ADD CONSTRAINT "LinhaDeLigacao_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinhaDeLigacao" ADD CONSTRAINT "LinhaDeLigacao_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LinhaDeLigacao" ADD CONSTRAINT "LinhaDeLigacao_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Por onde a ligação saiu. Coluna opcional, sem valor padrão: não reescreve a tabela.
ALTER TABLE "Call" ADD COLUMN "linhaId" TEXT;
-- NOT VALID: não confere as linhas antigas agora (todas têm linhaId nulo). A conferência é a próxima migration.
ALTER TABLE "Call" ADD CONSTRAINT "Call_linhaId_fkey" FOREIGN KEY ("linhaId") REFERENCES "LinhaDeLigacao"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- RLS: tabela com teamId nasce com a política por time.
ALTER TABLE "LinhaDeLigacao" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_por_time ON "LinhaDeLigacao";
CREATE POLICY isolamento_por_time ON "LinhaDeLigacao" FOR ALL TO crmagro_app
  USING ("teamId" = (SELECT current_setting('app.team_id', true)))
  WITH CHECK ("teamId" = (SELECT current_setting('app.team_id', true)));
