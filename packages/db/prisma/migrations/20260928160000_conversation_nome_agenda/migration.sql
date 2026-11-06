-- Nome da conversa (pedido do dono, 28/09): o nome que o dono SALVOU NA AGENDA
-- do celular fica separado do pushName (`externalName`) para manter a ordem
-- contato cadastrado > agenda > pushName (só de mensagem recebida) > número.
-- Coluna nula, sem default: não reescreve a tabela nem trava escrita.
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "nomeAgenda" TEXT;
