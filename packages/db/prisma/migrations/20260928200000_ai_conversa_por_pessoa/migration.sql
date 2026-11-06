-- Histórico do assistente de IA por pessoa (auditoria de isolamento 09/2026).
-- Antes, toda conversa com o assistente era do TIME: qualquer membro listava,
-- abria, sobrescrevia e apagava a conversa do master (com respostas tiradas da
-- base inteira). Agora cada conversa tem dono; as antigas ficam sem dono
-- (null) e só quem vê tudo (master, administrador, "ver tudo") as enxerga.
-- Tabela pequena (uma linha por conversa): coluna nula = só metadado; o índice
-- e a FK são rápidos.

-- AlterTable
ALTER TABLE "AiConversation" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "AiConversation_teamId_userId_updatedAt_idx" ON "AiConversation"("teamId", "userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
