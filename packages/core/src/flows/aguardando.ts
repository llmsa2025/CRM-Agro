import { db } from "@crmagro/db";
import { logger } from "../logger/index";
import { acordarPasso } from "./queue";

/**
 * Chegou mensagem do contato → acorda as inscrições dele que estão esperando
 * resposta (item 1.1, MF-02). Antes, cada uma re-checava sozinha a cada 30 s.
 *
 * A marca `waitingFor` é limpa de forma otimista (`updateMany` com o próprio
 * filtro): duas mensagens seguidas não acordam o mesmo passo duas vezes. O
 * passo roda a condição de novo; se a resposta não for no canal pedido, a
 * condição volta a esperar pelo resto da janela.
 *
 * Roda dentro do contexto do time. Nunca derruba o recebimento da mensagem.
 */
export async function acordarQuemEsperaResposta(contactId: string, agora = new Date()): Promise<number> {
  try {
    const prisma = db();
    const esperando = await prisma.enrollment.findMany({
      where: { contactId, status: "waiting", waitingFor: "reply" },
      select: { id: true, currentNodeId: true, currentRound: true },
    });
    let acordadas = 0;
    for (const e of esperando) {
      const { count } = await prisma.enrollment.updateMany({
        where: { id: e.id, status: "waiting", waitingFor: "reply" },
        data: { waitingFor: null, waitingUntil: null, status: "active", nextRunAt: agora },
      });
      if (count !== 1 || e.currentRound < 1) continue;
      await acordarPasso(e.id, e.currentNodeId, e.currentRound);
      acordadas++;
    }
    return acordadas;
  } catch (err) {
    // A varredura de órfãs (0.9) e o job de timeout cobrem se falhar aqui.
    logger.warn({ contactId, err: err instanceof Error ? err.message : String(err) }, "[flow] falha ao acordar quem espera resposta");
    return 0;
  }
}
