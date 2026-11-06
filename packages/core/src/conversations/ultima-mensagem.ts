import type { Direcao } from "@prisma/client";
import { db, getCurrentTeamId } from "@crmagro/db";
import { invalidarCache, lerOuCalcular } from "../shared/cache-curto";
import { chaveDoEscopo } from "../tenancy/escopo";
import { escopoConversa } from "./escopo";

/**
 * Resumo da última mensagem na Conversation + contador de não-lidas do time
 * (item 2.2, DP-01/N10).
 *
 * Toda mensagem gravada (entrada, saída pela plataforma, eco `fromMe`, e-mail
 * enviado/recebido) passa por `touchConversation`, que grava NA MESMA ESCRITA o
 * `lastMessageAt` e a prévia (`lastMessagePreview/Direcao/Subject`). A lista do
 * inbox lê só a Conversation — antes buscava a última Message de cada conversa,
 * o que carregava todas as mensagens da conta a cada mensagem que chegava.
 *
 * Módulo separado do `service.ts` para o e-mail (`email/service.ts`) usar sem
 * import circular.
 */

/** Tamanho máximo da prévia (a lista corta visualmente; o resto não é lido). */
export const PREVIEW_MAX = 200;

/** Texto da prévia: o conteúdo (cortado) ou o tipo da mídia, ex.: "[image]". */
export function previewDaMensagem(conteudo: string | null | undefined, tipo: string = "text"): string {
  const texto = (conteudo ?? "").trim();
  if (texto) return texto.length > PREVIEW_MAX ? `${texto.slice(0, PREVIEW_MAX - 1)}…` : texto;
  return tipo === "text" ? "" : `[${tipo}]`;
}

export type UltimaMensagem = {
  preview: string;
  direcao: Direcao;
  /** E-mail: assunto. WhatsApp: omitir. */
  subject?: string | null;
  /** Hora da mensagem (INT-16: a do WhatsApp, não a da ingestão). Padrão: agora. */
  quando?: Date;
  /** Quantas não-lidas somar (só mensagem RECEBIDA conta). */
  naoLidas?: number;
};

/**
 * Atualiza a conversa com a mensagem nova: `lastMessageAt` + prévia na mesma
 * escrita, e soma as não-lidas. Roda em runWithTeam/runAsSystem.
 *
 * `lastMessageAt = max(atual, quando)`: mensagem antiga reentregue depois de uma
 * queda não "puxa" a conversa para o topo nem troca a prévia (INT-16). Empate
 * (`lte`) atualiza: o timestamp do WhatsApp é em SEGUNDOS, e duas mensagens no
 * mesmo segundo são comuns — vale a processada por último.
 */
export async function touchConversation(conversationId: string, ultima: UltimaMensagem): Promise<void> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  const quando = ultima.quando ?? new Date();
  const naoLidas = ultima.naoLidas ?? 0;
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: quando } }] },
    data: {
      lastMessageAt: quando,
      lastMessagePreview: ultima.preview,
      lastMessageDirecao: ultima.direcao,
      lastMessageSubject: ultima.subject ?? null,
      ...(naoLidas ? { unreadCount: { increment: naoLidas } } : {}),
    },
  });
  if (!naoLidas) return;
  // Mensagem mais antiga que a última: não mexe na prévia, mas conta como não-lida.
  if (count === 0) {
    await prisma.conversation.updateMany({
      where: { id: conversationId },
      data: { unreadCount: { increment: naoLidas } },
    });
  }
  await invalidarNaoLidas(teamId);
}

// ─── Contador de não-lidas (badge do menu) ──────────────────────────────────

/** 30 s: o badge não precisa ser instantâneo, e a invalidação cobre o resto. */
export const NAO_LIDAS_TTL_S = 30;
const chaveNaoLidas = (teamId: string) => `inbox:naolidas:${teamId}`;

/**
 * Quantas conversas do time têm mensagem não lida (badge do menu). Só conta
 * conversa ligada a uma conta — a que não tem conta não aparece em lista
 * nenhuma, e o badge apontaria para algo que o usuário não acha.
 * Cache Redis de 30 s por time, invalidado quando o `unreadCount` muda.
 */
export async function countUnreadConversations(): Promise<number> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  // F3: só as conversas dos números que a pessoa vê; o cache é por escopo
  // ("tudo" ou o userId) e todos caem juntos pela geração do time.
  const onde = escopoConversa();
  const contar = () =>
    prisma.conversation.count({ where: { AND: [{ unreadCount: { gt: 0 }, channelAccountId: { not: null } }, onde] } });
  // Sem time no contexto a extensão devolve zero (fail-closed); não há o que cachear.
  if (!teamId) return contar();
  const escopo = chaveDoEscopo("conversas");
  return lerOuCalcular(`${chaveNaoLidas(teamId)}:${escopo}`, NAO_LIDAS_TTL_S, contar, chaveNaoLidas(teamId));
}

/**
 * Invalida o contador do time (chamar DEPOIS de gravar a mudança do
 * `unreadCount`). `teamId` lido no início do serviço (ALS eager, §12).
 */
export async function invalidarNaoLidas(teamId: string | null): Promise<void> {
  if (teamId) await invalidarCache(chaveNaoLidas(teamId));
}
