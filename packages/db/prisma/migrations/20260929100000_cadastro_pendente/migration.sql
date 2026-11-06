-- Cadastro de empresa com e-mail e senha COM confirmação obrigatória do e-mail
-- (core/auth/cadastro-com-senha.ts). Tabela nova e vazia: não mexe em nada que
-- existe. A conta (time + usuário) só nasce quando o link do e-mail é aberto e a
-- senha do cadastro é digitada; até lá, o pedido fica aqui (só o sha256 do
-- token) e a retenção apaga o que venceu.

-- CreateTable
CREATE TABLE "CadastroPendente" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "empresaNome" TEXT NOT NULL,
    "empresaCnpj" TEXT,
    "empresaCidade" TEXT,
    "empresaEstado" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CadastroPendente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CadastroPendente_tokenHash_key" ON "CadastroPendente"("tokenHash");

-- CreateIndex
CREATE INDEX "CadastroPendente_email_idx" ON "CadastroPendente"("email");

-- CreateIndex
CREATE INDEX "CadastroPendente_expiresAt_idx" ON "CadastroPendente"("expiresAt");

