-- Google Agenda (fase 1, revisão do #169): revogação DURÁVEL. Quando o Google
-- não confirma a revogação do token (rede/Google fora) ao desconectar,
-- desativar ou excluir a pessoa, a conexão sai do mesmo jeito e só o token
-- (cifrado) fica nesta fila até o worker conseguir revogar — com tentativas
-- limitadas; depois disso a linha sai de qualquer jeito. Tabela nova, aditiva.

-- CreateTable
CREATE TABLE "OAuthRevogacaoPendente" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "credentials" JSONB NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "proximaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoErro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthRevogacaoPendente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OAuthRevogacaoPendente_proximaEm_idx" ON "OAuthRevogacaoPendente"("proximaEm");

-- AddForeignKey
ALTER TABLE "OAuthRevogacaoPendente" ADD CONSTRAINT "OAuthRevogacaoPendente_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
