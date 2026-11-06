import { getCurrentTeamId } from "@crmagro/db";
import { redisEstado } from "../shared/redis-cache";
import { logger } from "../logger/index";

/**
 * Tetos do assistente de IA (item 3.5, INT-24): prazo por conversa,
 * cancelamento quando a tela desiste e cota diária de busca na web por time.
 */

/**
 * Prazo de UMA rodada do agente. Fica abaixo do SSE da rota (180 s) para o
 * resultado sempre chegar à tela: antes o SSE dizia "tempo esgotado" e o worker
 * seguia executando tools de escrita; o usuário repetia e criava em dobro.
 */
export const AI_AGENT_DEADLINE_MS = Number(process.env.AI_AGENT_DEADLINE_MS ?? 150_000);

const chaveCancelamento = (teamId: string, streamId: string) => `ai:cancel:${teamId}:${streamId}`;

/** A rota marca a conversa como cancelada (cliente saiu ou o SSE esgotou). */
export async function cancelarConversaIa(teamId: string, streamId: string): Promise<void> {
  try {
    await redisEstado().set(chaveCancelamento(teamId, streamId), "1", "EX", 600);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e), streamId }, "[ai] não deu para marcar o cancelamento");
  }
}

/** O worker confere antes de cada passo e de cada tool. Redis fora → segue (o prazo ainda limita). */
export async function conversaIaCancelada(teamId: string, streamId: string): Promise<boolean> {
  try {
    return (await redisEstado().exists(chaveCancelamento(teamId, streamId))) === 1;
  } catch {
    return false;
  }
}

// ─── Cota diária de web_search ──────────────────────────────────────────────

/** Buscas por time por dia (a busca usa a chave Tavily da PLATAFORMA). Lido a cada chamada. */
export function limiteDeBuscaPorDia(): number {
  return Number(process.env.AI_WEB_SEARCH_POR_DIA ?? 50);
}

export class CotaDeBuscaEsgotada extends Error {
  constructor(limite: number) {
    super(`Cota diária de busca na web esgotada (${limite}/dia). Siga com o que já tem ou tente amanhã.`);
    this.name = "CotaDeBuscaEsgotada";
  }
}

// Formatador criado uma vez (Intl é caro por chamada). en-CA → "AAAA-MM-DD".
const DIA_SP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/**
 * Consome 1 busca da cota do dia do time (dia de São Paulo). Passou do teto →
 * `CotaDeBuscaEsgotada`. Redis fora → nega (a busca gasta crédito pago; sem
 * como contar, não busca).
 */
export async function consumirCotaDeBusca(now: Date = new Date()): Promise<{ usadas: number; limite: number }> {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("web_search sem time no contexto");
  const chave = `ai:websearch:${teamId}:${DIA_SP.format(now)}`;
  let usadas: number;
  try {
    const res = await redisEstado().multi().incr(chave).expire(chave, 2 * 86_400).exec();
    usadas = Number(res?.[0]?.[1]);
    if (!Number.isFinite(usadas)) throw new Error("resposta inesperada do Redis");
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e), teamId }, "[ai] cota de busca indisponível — negando");
    throw new Error("Busca na web indisponível agora (não deu para conferir a cota).");
  }
  const limite = limiteDeBuscaPorDia();
  if (usadas > limite) throw new CotaDeBuscaEsgotada(limite);
  return { usadas, limite };
}
