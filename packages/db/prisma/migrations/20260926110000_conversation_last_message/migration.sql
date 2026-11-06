-- Item 2.2 (DP-01): resumo da última mensagem na própria Conversation. Colunas
-- nulas sem default: no Postgres é só catálogo (sem reescrever a tabela).
-- O preenchimento das conversas antigas é o script
-- `packages/db/scripts/backfill-ultima-mensagem.mjs` (rodar depois do deploy).

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastMessageDirecao" "Direcao",
ADD COLUMN     "lastMessagePreview" TEXT,
ADD COLUMN     "lastMessageSubject" TEXT;
