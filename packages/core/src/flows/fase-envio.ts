import type { Prisma } from "@prisma/client";
import { db } from "@crmagro/db";
import { ChannelSendFailed } from "@crmagro/channels";

/**
 * Fases do passo com efeito externo (item 1.2, MF-03). Gravadas no `result` do
 * FlowStepExecution DURANTE o passo, para o retry saber o que já aconteceu:
 *
 * - `enviando`: vai chamar o canal AGORA (tudo antes disso é pré-envio);
 * - `enviado`: o canal confirmou (com o `providerMessageId`).
 *
 * Erro/queda sem marca = nada saiu → pode repetir. Com `enviando` e sem
 * `enviado` = não dá para saber → segura para revisão. Com `enviado` = saiu →
 * avança (nunca reenvia).
 */
export const EFEITO_EXTERNO: ReadonlySet<string> = new Set([
  "send_message",
  "http_request",
  "send_email",
  "send_social",
  "ai_agent",
]);

export type MarcaDeEnvio = { fase: "enviando" } | { fase: "enviado"; enviado: true; providerMessageId?: string };

export function lerMarcaDeEnvio(result: unknown): "enviado" | "enviando" | null {
  const r = result as { fase?: string; enviado?: boolean } | null;
  if (r?.enviado || r?.fase === "enviado") return "enviado";
  if (r?.fase === "enviando") return "enviando";
  return null;
}

/**
 * Grava a marca no passo corrente. Sem `round` (executor chamado fora do
 * worker, ex.: testes) não há passo a marcar. Falha ao marcar "enviado" vira
 * resultado INCERTO — nunca "não saiu" (reenviaria).
 */
export async function marcarFaseDoPasso(
  alvo: { enrollmentId: string; nodeId: string; round?: number },
  marca: MarcaDeEnvio,
): Promise<void> {
  if (alvo.round === undefined) return;
  try {
    await db().flowStepExecution.updateMany({
      where: { enrollmentId: alvo.enrollmentId, nodeId: alvo.nodeId, round: alvo.round },
      data: { result: marca as unknown as Prisma.InputJsonValue },
    });
  } catch (e) {
    if (marca.fase === "enviado") {
      throw new ChannelSendFailed(
        `enviado, mas não consegui registrar: ${e instanceof Error ? e.message : String(e)}`,
        "unknown",
        false,
      );
    }
    throw e;
  }
}
