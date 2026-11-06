import { getCurrentTeamId } from "@crmagro/db";
import { publishRealtime } from "../events/redis-bus";
import { invalidarPainel } from "../dashboard/cache";

/**
 * Barramento de eventos de conversa. O service publica aqui quando uma mensagem
 * entra (receiveInbound) ou sai (sendMessage).
 *
 * Destino: o barramento CROSS-PROCESSO via Redis (`publishRealtime`). Substituiu
 * o `EventEmitter` in-process + SSE, que só entregava dentro do mesmo processo —
 * um evento nascido no worker (motor de fluxos) nunca chegava ao inbox no
 * navegador. Agora o Socket.IO server assina o Redis e reemite pra room do time.
 *
 * Roteamento por `teamId`: lido do contexto de tenancy (ALS) dentro do
 * `publishRealtime`. Publicar é best-effort (fail-open): se o Redis cair, o
 * polling de reconciliação no cliente ainda cobre. Ver `events/redis-bus.ts`.
 */

export type ConversationEvent = {
  type: "message:received" | "message:sent";
  channelAccountId: string;
  conversationId: string;
  message: {
    id: string;
    direcao: string;
    conteudo: string | null;
    createdAt: string;
  };
};

export function emitConversationEvent(event: ConversationEvent): void {
  // Evento da conversa em si (inbox ao vivo).
  publishRealtime(event);
  // Toda mensagem é uma atividade (toque) que mexe nos KPIs: invalida o cache do
  // Painel (30 s, item 2.3) ANTES de avisar, para o refetch já ler o número novo.
  const teamId = getCurrentTeamId();
  if (teamId) void invalidarPainel(teamId);
  publishRealtime({ type: "dashboard:changed" });
}

/**
 * Emite a atualização de status (✓/✓✓) de uma mensagem pra tela atualizar o
 * tique ao vivo. NÃO publica dashboard:changed — recibo não é nova atividade.
 */
export function emitMessageStatus(e: {
  channelAccountId: string;
  conversationId: string;
  messageId: string;
  status: string;
}): void {
  publishRealtime({ type: "message:status", ...e });
}
