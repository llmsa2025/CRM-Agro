import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { assertOwned } from "../tenancy/assert-owned";
import { FlowNotActive, FlowNotFound } from "./errors";
import { escopoFluxo, escopoInscricao } from "./escopo";
import { retomarInscricoesSeguradas } from "./controle";

/**
 * Andamento do fluxo por estado (incidente de 02/10/2026): quem olhava a tela via pouco acontecer e pausava e ativava de
 * novo, o que piorava tudo. Aqui cada inscrição do fluxo cai em UM estado, com a contagem, e a tela mostra o motivo.
 * Ramos paralelos não contam (são parte da mesma pessoa), como em `listFlowsWithMetrics`. Só as inscrições que a pessoa vê
 * (escopo por dono).
 */
export type AndamentoDoFluxo = {
  fluxoStatus: string;
  /** Pessoas no fluxo (todas as inscrições de origem). */
  total: number;
  /** Com o passo para rodar agora ou rodando. */
  executando: number;
  /** Esperando um horário: passo "Esperar", fora do horário de envio, limite de envios, jitter. */
  aguardando: number;
  /** Esperando a resposta da pessoa. */
  aguardandoResposta: number;
  /** DM esperando a vez na fila social. */
  naFilaSocial: number;
  /** Seguradas porque o fluxo foi pausado; voltam ao ativar (ou no botão "Retomar as seguradas", com o fluxo no ar). */
  seguradasPelaPausa: number;
  /** Seguradas para uma pessoa decidir (resultado incerto, ligação pendente, passo vencido): aba Histórico. */
  seguradasParaRevisao: number;
  concluidas: number;
  falhas: number;
};

export async function andamentoDoFluxo(flowId: string): Promise<AndamentoDoFluxo> {
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] }, select: { status: true } });
  if (!flow) throw new FlowNotFound(flowId);
  const where = { flowId, paiId: null, AND: [escopoInscricao()] };
  const [grupos, semHorario] = await Promise.all([
    prisma.enrollment.groupBy({ by: ["status", "waitingFor"], where, _count: { _all: true } }),
    // `waiting` sem horário nem marca: segurada para revisão (a da pausa tem a marca `fluxo_pausado`).
    prisma.enrollment.count({ where: { ...where, status: "waiting", waitingFor: null, nextRunAt: null } }),
  ]);
  const a: AndamentoDoFluxo = {
    fluxoStatus: flow.status,
    total: 0,
    executando: 0,
    aguardando: 0,
    aguardandoResposta: 0,
    naFilaSocial: 0,
    seguradasPelaPausa: 0,
    seguradasParaRevisao: semHorario,
    concluidas: 0,
    falhas: 0,
  };
  for (const g of grupos) {
    const n = g._count._all;
    a.total += n;
    if (g.status === "active") a.executando += n;
    else if (g.status === "done") a.concluidas += n;
    else if (g.status === "failed") a.falhas += n;
    else if (g.waitingFor === "fluxo_pausado") a.seguradasPelaPausa += n;
    else if (g.waitingFor === "reply") a.aguardandoResposta += n;
    else if (g.waitingFor === "social") a.naFilaSocial += n;
    else a.aguardando += n; // waiting sem marca; abaixo tira as seguradas para revisão
  }
  a.aguardando = Math.max(0, a.aguardando - semHorario);
  return a;
}

/**
 * Botão "Retomar as seguradas": devolve ao passo em que pararam as inscrições seguradas pela pausa, com o fluxo NO AR.
 * (Ativar um fluxo pausado já faz isso; o botão serve quando o fluxo está no ar e ficou gente para trás.) Retomar põe
 * as pessoas para rodar, então vale a mesma permissão de ativar. Lotes, ordem de entrada e idempotência: `controle.ts`.
 */
export async function retomarSeguradasDoFluxo(flowId: string): Promise<{ retomadas: number }> {
  requireCan("flows.activate");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] }, select: { status: true } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  if (flow.status !== "active") throw new FlowNotActive(flowId);
  return { retomadas: await retomarInscricoesSeguradas(flowId) };
}
