import { db, getCurrentTeamId } from "@crmagro/db";
import { isUniqueViolation } from "../contacts/errors";
import { invalidarNaoLidas } from "./ultima-mensagem";

/**
 * Liga uma conversa a um contato respeitando o índice único parcial
 * (channelAccountId, contactId) — item 0.8 (INT-02): um contato tem UMA
 * conversa por conta.
 *
 * Se o contato já tem conversa naquela conta (ex.: número não cadastrado que
 * conversou antes do cadastro; unificação de contatos), a conversa de origem é
 * MESCLADA na existente — mensagens movidas, não-lidas somadas, a origem
 * apagada — em vez de estourar o índice. Devolve o id da conversa que ficou.
 *
 * Roda dentro do contexto do time (`db()` com tenancy).
 */
export async function vincularConversaAoContato(conversationId: string, contactId: string): Promise<string> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { contactId, externalNumber: null },
    });
    return conversationId;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  const origem = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      channelAccountId: true,
      unreadCount: true,
      lastMessageAt: true,
      lastMessagePreview: true,
      lastMessageDirecao: true,
      lastMessageSubject: true,
    },
  });
  if (!origem) return conversationId;
  const destino = await prisma.conversation.findFirst({
    where: { contactId, channelAccountId: origem.channelAccountId, id: { not: conversationId } },
    select: { id: true, lastMessageAt: true },
  });
  if (!destino) throw new Error("conversa do contato não encontrada para mesclar");

  // A origem é mais recente → a prévia dela (item 2.2) vai junto com o horário.
  const origemMaisNova =
    !!origem.lastMessageAt && (!destino.lastMessageAt || origem.lastMessageAt > destino.lastMessageAt);
  await prisma.$transaction(async (tx) => {
    await tx.message.updateMany({ where: { conversationId }, data: { conversationId: destino.id } });
    await tx.conversation.update({
      where: { id: destino.id },
      data: {
        unreadCount: { increment: origem.unreadCount },
        ...(origemMaisNova
          ? {
              lastMessageAt: origem.lastMessageAt,
              lastMessagePreview: origem.lastMessagePreview,
              lastMessageDirecao: origem.lastMessageDirecao,
              lastMessageSubject: origem.lastMessageSubject,
            }
          : {}),
      },
    });
    await tx.conversation.delete({ where: { id: conversationId } });
  });
  // Duas conversas com não-lidas viraram uma: o badge muda.
  if (origem.unreadCount) await invalidarNaoLidas(teamId);
  return destino.id;
}
