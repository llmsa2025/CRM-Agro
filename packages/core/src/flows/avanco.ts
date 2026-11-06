import type { Prisma } from "@prisma/client";
import { basePrisma, db, type TenantPrismaClient } from "@crmagro/db";
import { logger } from "../logger/index";
import type { NodeResult } from "./executor";
import { flowJobId, getStepJobState, removeStepJob, scheduleStep } from "./queue";
import { estadoDoEnvioSocial } from "./fila-social";

/**
 * Avanço do motor sem inscrição órfã (item 0.9 — auditoria MF-01).
 *
 * Antes: o passo era marcado `done`, DEPOIS o enrollment era atualizado e SÓ
 * ENTÃO o próximo passo ia para o Redis — três escritas soltas. Uma falha entre
 * elas (pool do banco, Redis piscando, deploy) deixava a inscrição "active" sem
 * job nenhum, para sempre; e a trava de reinscrição a via "em curso", então o
 * contato nunca mais entrava no fluxo.
 *
 * Agora:
 * 1. `concluirPasso` fecha o passo E move o PONTEIRO da inscrição
 *    (currentNodeId + currentRound + nextRunAt) numa transação só;
 * 2. o agendamento no Redis vem depois — se falhar, o ponteiro já diz o que
 *    falta, e `varrerInscricoesOrfas` (worker primário, 5 min) reagenda;
 * 3. `reagendarPeloPonteiro` cobre o retry que acha o passo já `done`.
 */

export type ProximoPasso = { nodeId: string; round: number; delayMs?: number };

/** Contador de execuções de um nó (qualquer cliente: tenant, transação). */
type ContaExecucoes = { flowStepExecution: { count(args: { where: { enrollmentId: string; nodeId: string } }): Promise<number> } };

/** Round da próxima entrada no nó (N-ésima vez que a inscrição passa por ele). */
async function proximoRound(prisma: ContaExecucoes, enrollmentId: string, nodeId: string): Promise<number> {
  return (await prisma.flowStepExecution.count({ where: { enrollmentId, nodeId } })) + 1;
}

/**
 * O job é do passo em que a inscrição ESTÁ? (item 1.9, MF-17). Job obsoleto —
 * 2º clique em "definir destino", job velho que sobreviveu no Redis — não roda.
 * Round 0 = inscrição anterior à coluna currentRound (aceita pelo nó).
 */
export function jobNoPonteiro(enr: { currentNodeId: string; currentRound: number }, nodeId: string, round: number): boolean {
  return enr.currentNodeId === nodeId && (enr.currentRound === round || enr.currentRound === 0);
}

/**
 * Onde a inscrição TEM de estar para este passo mexer nela (item 1.9, MF-17):
 * no mesmo nó/round e em curso. Round 0 = inscrição anterior à coluna.
 * Compare-and-set: se um "definir destino", um "parar tudo" ou outro job mexeu
 * no ponteiro durante o passo, o passo fecha mas NÃO avança nem ressuscita a
 * inscrição encerrada.
 */
function noPonteiro(enrollmentId: string, nodeId: string, round: number) {
  return { id: enrollmentId, currentNodeId: nodeId, currentRound: { in: [round, 0] }, status: { in: ["active" as const, "waiting" as const] } };
}

/**
 * Fecha o passo (`done` + result) e move o ponteiro da inscrição na MESMA
 * transação. Devolve o próximo passo a agendar (ou null: terminou / travado /
 * o ponteiro mudou durante o passo). Roda dentro do contexto do time (`db()`).
 */
export async function concluirPasso(input: {
  enrollmentId: string;
  nodeId: string;
  round: number;
  result: NodeResult;
  agora?: Date;
  /** Passo pulado com motivo (item 1.2: envio impossível) em vez de `done`. */
  status?: "done" | "skipped";
  error?: string;
}): Promise<ProximoPasso | null> {
  const { enrollmentId, nodeId, round, result } = input;
  const agora = input.agora ?? new Date();
  const prisma = db();
  const feito = await prisma.$transaction(async (tx) => {
    await tx.flowStepExecution.updateMany({
      where: { enrollmentId, nodeId, round },
      data: {
        status: input.status ?? "done",
        result: result as unknown as Prisma.InputJsonValue,
        finishedAt: agora,
        ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      },
    });

    // Passo TRAVADO (revenda segurada / ligação manual): espera ação humana.
    if (result.hold) {
      const { count } = await tx.enrollment.updateMany({
        where: noPonteiro(enrollmentId, nodeId, round),
        data: { status: "waiting", nextRunAt: null, currentNodeId: nodeId, currentRound: round, waitingFor: null, waitingUntil: null },
      });
      if (count !== 1) logger.warn({ enrollmentId, nodeId, round }, "[flow] ponteiro mudou durante o passo — não segura");
      return { prox: null, ramos: [] };
    }

    // Saída com vários destinos (condição): segue no primeiro; cada um dos outros vira um RAMO (inscrição filha)
    // criado junto com a mudança do ponteiro, logo abaixo.
    const destinos = result.nextNodeIds && result.nextNodeIds.length > 1 ? result.nextNodeIds : null;
    const nextNodeId = destinos ? destinos[0]! : result.nextNodeId;
    const espera = result.delayMs !== undefined && result.delayMs > 0;
    // Próximo round: conta com o passo atual já gravado (se reentra no mesmo
    // nó — poll da condição "respondeu?" — vira round + 1).
    const nextRound = nextNodeId ? await proximoRound(tx, enrollmentId, nextNodeId) : round;
    const { count } = await tx.enrollment.updateMany({
      where: noPonteiro(enrollmentId, nodeId, round),
      data: {
        stepNumber: { increment: 1 },
        currentNodeId: nextNodeId ?? nodeId,
        currentRound: nextRound,
        status: nextNodeId === null ? "done" : espera ? "waiting" : "active",
        nextRunAt: nextNodeId === null ? null : espera ? new Date(agora.getTime() + (result.delayMs ?? 0)) : agora,
        // Espera por resposta (item 1.1): marca para o inbound acordar; qualquer
        // outro resultado limpa a marca.
        waitingFor: result.aguardandoResposta ? "reply" : null,
        waitingUntil: result.aguardandoResposta ? new Date(result.aguardandoResposta.ate) : null,
        ...(result.sideEffects?.lastOutboundAt ? { lastOutboundAt: result.sideEffects.lastOutboundAt } : {}),
      },
    });
    if (count !== 1) {
      logger.warn({ enrollmentId, nodeId, round }, "[flow] ponteiro mudou durante o passo — passo fechado sem avançar");
      return { prox: null, ramos: [] };
    }
    const ramos = destinos ? await criarRamos(tx, enrollmentId, destinos.slice(1), agora) : [];
    return { prox: nextNodeId ? { nodeId: nextNodeId, round: nextRound, ...(espera ? { delayMs: result.delayMs } : {}) } : null, ramos };
  });
  // Os ramos já existem (mesma transação). Agendar é depois do commit; se falhar, a varredura de órfãs acha (ponteiro + nextRunAt).
  for (const ramo of feito.ramos) {
    await scheduleStep(ramo.id, ramo.nodeId, 1).catch((err) => logger.warn({ err, enrollmentId: ramo.id }, "[flow] não deu para agendar o ramo; a varredura reagenda"));
  }
  return feito.prox;
}

/** Teto de ramos por inscrição de origem: um ciclo com saída de vários destinos não pode multiplicar sem fim. */
export const MAX_RAMOS_POR_INSCRICAO = 20;

/**
 * Cria um ramo (inscrição filha) para cada destino extra: mesmo fluxo, contato e versão do grafo, começando no
 * destino, ao mesmo tempo que os outros. Cada ramo tem ponteiro, espera, segura e falha por conta própria. Passos e
 * limites por contato seguem valendo (o `stepNumber` herdado também limita ciclos). Passou do teto: não cria (avisa no log).
 */
async function criarRamos(tx: Pick<TenantPrismaClient, "enrollment">, paiEnrollmentId: string, destinos: string[], agora: Date): Promise<Array<{ id: string; nodeId: string }>> {
  if (destinos.length === 0) return [];
  const pai = await tx.enrollment.findUnique({ where: { id: paiEnrollmentId } });
  if (!pai) return [];
  const origemId = pai.paiId ?? pai.id;
  const jaTem = await tx.enrollment.count({ where: { paiId: origemId } });
  if (jaTem + destinos.length > MAX_RAMOS_POR_INSCRICAO) {
    logger.warn({ enrollmentId: paiEnrollmentId, jaTem, novos: destinos.length }, "[flow] teto de ramos paralelos: destinos extras não criados");
    return [];
  }
  const criados: Array<{ id: string; nodeId: string }> = [];
  for (const nodeId of destinos) {
    const ramo = await tx.enrollment.create({
      data: {
        teamId: pai.teamId,
        flowId: pai.flowId,
        contactId: pai.contactId,
        paiId: origemId,
        currentNodeId: nodeId,
        currentRound: 1,
        status: "active",
        nextRunAt: agora,
        stepNumber: pai.stepNumber, // já com o passo da condição contado: o limite de passos vale para o ramo também
        lastOutboundAt: pai.lastOutboundAt,
        profundidade: pai.profundidade,
        snapshotVersion: pai.snapshotVersion,
        flowVersionId: pai.flowVersionId,
        ...(pai.flowSnapshot ? { flowSnapshot: pai.flowSnapshot as Prisma.InputJsonValue } : {}),
      },
    });
    criados.push({ id: ramo.id, nodeId });
  }
  return criados;
}

/**
 * Retry que encontrou o passo já `done` (a 1ª tentativa fechou o passo mas
 * morreu antes de agendar): agenda o que o PONTEIRO diz. O jobId determinístico
 * torna isto idempotente — se o job já existe, o `add` é ignorado.
 */
export async function reagendarPeloPonteiro(enrollmentId: string, agora = new Date()): Promise<boolean> {
  const enr = await db().enrollment.findUnique({
    where: { id: enrollmentId },
    select: { status: true, currentNodeId: true, currentRound: true, nextRunAt: true },
  });
  if (!enr || (enr.status !== "active" && enr.status !== "waiting") || !enr.nextRunAt || enr.currentRound < 1) {
    return false;
  }
  const delay = Math.max(0, enr.nextRunAt.getTime() - agora.getTime());
  await scheduleStep(enrollmentId, enr.currentNodeId, enr.currentRound, delay || undefined, enr.nextRunAt.getTime());
  return true;
}

// ---------------------------------------------------------------------------
// Varredura de órfãs (worker primário). Cross-team por natureza: roda sem
// contexto de time e só escreve no Redis (e marca `failed` pelo id).
// ---------------------------------------------------------------------------

const VIVOS = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

export type FilaDePassos = {
  estado: (jobId: string) => Promise<string | null>;
  remover: (jobId: string) => Promise<void>;
  agendar: (enrollmentId: string, nodeId: string, round: number, delayMs?: number, plannedAt?: number) => Promise<void>;
  /** Estado do DM do passo na fila `social` (item 1.8). */
  estadoSocial?: (enrollmentId: string, nodeId: string, round: number) => Promise<string | null>;
};

const filaReal: FilaDePassos = {
  estado: getStepJobState,
  remover: removeStepJob,
  agendar: scheduleStep,
  estadoSocial: estadoDoEnvioSocial,
};

/** Round devido de inscrição anterior à coluna currentRound (0): pelo histórico. */
async function roundLegado(enrollmentId: string, nodeId: string): Promise<number> {
  const ultimo = await basePrisma.flowStepExecution.findFirst({
    where: { enrollmentId, nodeId },
    orderBy: { round: "desc" },
    select: { round: true, status: true },
  });
  if (!ultimo) return 1;
  // Parado no meio (running/failed): o MESMO round — o claim decide com segurança.
  return ultimo.status === "done" || ultimo.status === "skipped" ? ultimo.round + 1 : ultimo.round;
}

/**
 * Inscrição active/waiting cujo passo devido venceu há mais de 5 min e que não
 * tem job vivo no Redis → reagenda. Job que terminou em falha definitiva →
 * marca a inscrição `failed` (visível), em vez de reagendar em loop.
 */
export async function varrerInscricoesOrfas(
  opts: { agora?: Date; limite?: number; fila?: FilaDePassos } = {},
): Promise<{ verificadas: number; reagendadas: number; falhas: number }> {
  const agora = opts.agora ?? new Date();
  const fila = opts.fila ?? filaReal;
  const candidatas = await basePrisma.enrollment.findMany({
    where: { status: { in: ["active", "waiting"] }, nextRunAt: { lt: new Date(agora.getTime() - 5 * 60_000) } },
    select: { id: true, currentNodeId: true, currentRound: true, nextRunAt: true, waitingFor: true },
    orderBy: { nextRunAt: "asc" },
    take: opts.limite ?? 200,
  });
  let reagendadas = 0;
  let falhas = 0;
  for (const e of candidatas) {
    const round = e.currentRound > 0 ? e.currentRound : await roundLegado(e.id, e.currentNodeId);
    // DM esperando na fila `social` (represada, conta ocupada): não é órfã.
    if (e.waitingFor === "social" && fila.estadoSocial) {
      const social = await fila.estadoSocial(e.id, e.currentNodeId, round);
      if (social && VIVOS.has(social)) continue;
    }
    const jobId = flowJobId(e.id, e.currentNodeId, round);
    const estado = await fila.estado(jobId);
    if (estado && VIVOS.has(estado)) continue; // tem job — só está atrasado
    if (estado === "failed") {
      // Tentativas esgotadas sem o ouvinte ter marcado: marca agora.
      await basePrisma.enrollment.updateMany({ where: { id: e.id }, data: { status: "failed", nextRunAt: null } });
      falhas++;
      continue;
    }
    // Sem job (ou "completed" sem ter avançado o ponteiro): reagenda.
    if (estado) await fila.remover(jobId);
    // plannedAt = quando devia ter rodado: envio muito atrasado é SEGURADO para
    // revisão pelo worker (FLOW_STALE_HOURS), não disparado fora de contexto.
    await fila.agendar(e.id, e.currentNodeId, round, undefined, e.nextRunAt?.getTime());
    reagendadas++;
  }
  if (reagendadas || falhas) {
    logger.warn({ verificadas: candidatas.length, orfas_reagendadas: reagendadas, falhas }, "[flow] varredura de órfãs");
  }
  return { verificadas: candidatas.length, reagendadas, falhas };
}
