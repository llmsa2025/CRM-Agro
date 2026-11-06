-- Alertas de saúde da PLATAFORMA configuráveis pela tela (Configurações → Alertas).
-- Migration ADITIVA: duas tabelas novas, nenhuma coluna ou tabela existente é tocada.
-- Gerada por `prisma migrate diff` (schema da main -> schema novo) + o bloco de RLS no fim.
--
-- Desfazer (nada depende delas fora deste PR; sem a tabela o app volta ao `.env`):
--   DROP TABLE "AlertaEnviado"; DROP TABLE "AlertaConfig";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007150000_alertas_do_sistema';
-- (primeiro volta o app para o build anterior, depois o banco.)

-- CreateTable
CREATE TABLE "AlertaConfig" (
    "id" TEXT NOT NULL,
    "ligado" BOOLEAN NOT NULL DEFAULT true,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "canalEmail" BOOLEAN NOT NULL DEFAULT true,
    "canalPush" BOOLEAN NOT NULL DEFAULT true,
    "motivosDesligados" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intervaloMinimoMin" INTEGER NOT NULL DEFAULT 30,
    "timeOperacaoId" TEXT,
    "atualizadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertaConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertaEnviado" (
    "id" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canal" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultado" TEXT NOT NULL,
    "destinatarios" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AlertaEnviado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertaEnviado_criadoEm_idx" ON "AlertaEnviado"("criadoEm");

-- RLS: tabelas da PLATAFORMA, sem teamId. RLS ligado e SEM política, e o
-- `crmagro_app` sem nenhum privilégio: só o papel dono (basePrisma) lê e grava, pelo código de
-- core/health/alertas-config.ts. Nenhum time alcança estas linhas, nem com a camada 3 do RLS ligada.
ALTER TABLE "AlertaConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlertaEnviado" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "AlertaConfig", "AlertaEnviado" FROM crmagro_app;
