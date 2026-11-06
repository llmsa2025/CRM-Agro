import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/**
 * Escopo dos canais e das conversas (F3, decisão do dono de 28/09): QUALQUER
 * número (pessoal ou da empresa) e caixa de e-mail é visto por quem conectou,
 * pelo master, pelo administrador e por quem tem "ver tudo" em Conversas. As conversas
 * seguem a conta: vejo a conversa se vejo o número por onde ela passa.
 * `{ escrita: true }`: os números/conversas que a pessoa pode USAR e alterar
 * (enviar, marcar lida, cadastrar contato) — "Ver e editar de todos".
 */
export function escopoCanal(uso: UsoDoEscopo = {}): Prisma.ChannelAccountWhereInput {
  return whereDoEscopo("conversas", "ownerId", { escrita: uso.escrita }) as Prisma.ChannelAccountWhereInput;
}

/** Conversa no escopo: a da conta de quem conectou (conversa sem conta = só quem vê tudo). */
export function escopoConversa(uso: UsoDoEscopo = {}): Prisma.ConversationWhereInput {
  const canal = escopoCanal(uso);
  return Object.keys(canal).length ? { channelAccount: canal } : {};
}
