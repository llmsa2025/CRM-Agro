import { db } from "@crmagro/db";
import { isChannelSendFailed } from "@crmagro/channels";
import { logger } from "../logger/index";
import { concluirPasso } from "./avanco";
import { ConsultaWhatsAppIndisponivel } from "./errors";
import { descreverFalhaDeEnvio, lerNumeroSemWhatsApp } from "./falha-legivel";
import { marcarNumeroSemWhatsApp } from "./numero-sem-whatsapp";
import { EFEITO_EXTERNO, lerMarcaDeEnvio } from "./fase-envio";
import { scheduleStep } from "./queue";
import type { NodeResult } from "./executor";
import type { SnapshotNode } from "./schema";

/**
 * O que fazer quando um passo do motor falha (item 1.2 — MF-03/INT-03).
 *
 * Antes: qualquer erro num nó de envio deixava o claim "running"; o retry do
 * BullMQ caía em "retomada insegura" e marcava a inscrição `failed` — as 5
 * tentativas nunca aconteciam, a causa real sumia no log do pm2 e a cota já
 * estava gasta. Uma hora de Evolution fora matava toda a base inscrita.
 *
 * Agora, na ordem:
 * 1. marca "enviado" no passo → o envio SAIU e algo depois falhou: AVANÇA;
 * 2. `ChannelSendFailed`:
 *    - `unknown` (pode ter saído) → SEGURA para revisão;
 *    - `not_sent` sem retry (número inválido, destino proibido) → PULA;
 *    - `not_sent` com retry (Evolution fora, 5xx, SMTP 4xx) → repete o MESMO
 *      nó com backoff 5/15/60 min (±20% de jitter); na 4ª falha, inscrição `failed`;
 * 3. marca "enviando" sem "enviado" num nó de envio → incerto → SEGURA;
 * 4. qualquer outro erro sem marca → nada saiu: apaga o claim e RELANÇA para
 *    o retry do BullMQ (5 tentativas; esgotou → o ouvinte marca `failed`).
 */

export const PREFIXO_NAO_SAIU = "envio não saiu:";
/** A condição "Tem WhatsApp" (conferir no WhatsApp) não teve resposta: não houve envio, então o texto não fala em envio. */
export const PREFIXO_CONSULTA = "consulta ao WhatsApp falhou:";
export const BACKOFF_ENVIO_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** Espalha `ms` em ±`fracao` (padrão 20%) para o retry de um lote de falhas não bater tudo junto. */
export function comJitter(ms: number, fracao = 0.2): number {
  return Math.round(ms * (1 - fracao + Math.random() * 2 * fracao));
}

export type DesfechoDaFalha = "avancou" | "segurado" | "pulado" | "reagendado" | "falhou" | "relancar";

function mensagemDe(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

/** Próximo nó de um passo de envio concluído (todos têm `nextNodeId`). */
function proximoDoEnvio(node: SnapshotNode): string | null {
  return "nextNodeId" in node ? (node.nextNodeId ?? null) : null;
}

/** O envio saiu: fecha o passo como feito e segue o fluxo. */
async function avancarEnvioFeito(alvo: { enrollmentId: string; nodeId: string; round: number }, node: SnapshotNode) {
  const result: NodeResult = { nextNodeId: proximoDoEnvio(node), sideEffects: { lastOutboundAt: new Date() } };
  const prox = await concluirPasso({ ...alvo, result });
  if (prox) await scheduleStep(alvo.enrollmentId, prox.nodeId, prox.round, prox.delayMs);
}

/** Resultado incerto: segura a inscrição no passo para um humano decidir. */
export async function segurarParaRevisao(alvo: { enrollmentId: string; nodeId: string; round: number }, motivo: string) {
  const prisma = db();
  await prisma.$transaction(async (tx) => {
    await tx.flowStepExecution.updateMany({
      where: alvo,
      data: { status: "failed", error: motivo.slice(0, 500), finishedAt: new Date() },
    });
    await tx.enrollment.update({
      where: { id: alvo.enrollmentId },
      data: {
        status: "waiting",
        nextRunAt: null,
        currentNodeId: alvo.nodeId,
        currentRound: alvo.round,
        waitingFor: null,
        waitingUntil: null,
      },
    });
  });
}

/** Reagenda o MESMO nó em round novo, com a espera da tentativa (5/15/60 min, ±20% de jitter). */
async function repetirNoMesmoNo(alvo: { enrollmentId: string; nodeId: string; round: number }, falhasAnteriores: number): Promise<void> {
  const { enrollmentId, nodeId } = alvo;
  const prisma = db();
  // Jitter de ±20%: centenas de inscrições que falham juntas (Evolution fora) não voltam todas no mesmo minuto.
  const delay = comJitter(BACKOFF_ENVIO_MS[falhasAnteriores]!);
  const proxRound = (await prisma.flowStepExecution.count({ where: { enrollmentId, nodeId } })) + 1;
  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      status: "waiting",
      currentNodeId: nodeId,
      currentRound: proxRound,
      nextRunAt: new Date(Date.now() + delay),
      waitingFor: null,
      waitingUntil: null,
    },
  });
  await scheduleStep(enrollmentId, nodeId, proxRound, delay);
}

/**
 * Trata o erro lançado por `executeNode`. Roda no contexto do time. Devolve
 * `"relancar"` quando o handler deve relançar o erro (retry do BullMQ).
 */
export async function tratarFalhaDoPasso(input: {
  enrollmentId: string;
  nodeId: string;
  round: number;
  node: SnapshotNode;
  erro: unknown;
}): Promise<DesfechoDaFalha> {
  const { enrollmentId, nodeId, round, node, erro } = input;
  const alvo = { enrollmentId, nodeId, round };
  const prisma = db();
  const passo = await prisma.flowStepExecution.findFirst({ where: alvo, select: { result: true } });
  const marca = lerMarcaDeEnvio(passo?.result);
  const msg = mensagemDe(erro);

  if (marca === "enviado") {
    logger.warn({ ...alvo, err: msg }, "[flow] envio saiu, falha depois — avançando");
    await avancarEnvioFeito(alvo, node);
    return "avancou";
  }

  // Condição "Tem WhatsApp" conferindo no WhatsApp sem resposta: é só uma pergunta, então repetir é sempre seguro.
  // Repete com espera crescente e, esgotadas as tentativas, SEGURA para revisão (não `failed`): o motor nunca escolhe um
  // ramo no escuro, e a pessoa decide pelo Histórico do fluxo depois de ver a conexão do WhatsApp.
  if (erro instanceof ConsultaWhatsAppIndisponivel) {
    // Conta só as falhas desde a última vez que o passo foi segurado: quem "devolve" o contato ao mesmo passo, no
    // Histórico, começa a contagem de novo em vez de ser segurado na primeira falha.
    const ultimaSegurada = await prisma.flowStepExecution.findFirst({
      where: { enrollmentId, nodeId, status: "failed", NOT: { error: { startsWith: PREFIXO_CONSULTA } } },
      orderBy: { round: "desc" },
      select: { round: true },
    });
    const falhasAnteriores = await prisma.flowStepExecution.count({
      where: { enrollmentId, nodeId, status: "failed", error: { startsWith: PREFIXO_CONSULTA }, round: { gt: ultimaSegurada?.round ?? 0 } },
    });
    if (falhasAnteriores >= BACKOFF_ENVIO_MS.length) {
      await segurarParaRevisao(
        alvo,
        `Não deu para conferir o número no WhatsApp (${erro.motivo}) depois de ${falhasAnteriores + 1} tentativas. Passo segurado: confira a conexão do WhatsApp e, no Histórico, devolva o contato a este mesmo passo.`,
      );
      return "segurado";
    }
    await prisma.flowStepExecution.updateMany({
      where: alvo,
      data: { status: "failed", error: `${PREFIXO_CONSULTA} ${erro.motivo}`.slice(0, 500), finishedAt: new Date() },
    });
    await repetirNoMesmoNo(alvo, falhasAnteriores);
    return "reagendado";
  }

  if (isChannelSendFailed(erro)) {
    if (erro.outcome === "unknown") {
      await segurarParaRevisao(alvo, `resultado incerto (pode ter saído): ${msg}`);
      return "segurado";
    }
    if (!erro.retryable) {
      // O log do fluxo mostra o texto em português; o texto técnico do canal fica no log do processo.
      logger.info({ ...alvo, err: msg }, "[flow] envio impossível, passo pulado");
      // Número sem WhatsApp: marca no cadastro para o próximo fluxo (e a condição "Tem WhatsApp") não bater no mesmo erro.
      // Não pode derrubar o tratamento da falha: se não der para marcar, o passo é pulado do mesmo jeito.
      const semZap = lerNumeroSemWhatsApp(msg);
      const marcado = semZap?.numero
        ? await marcarNumeroSemWhatsApp(enrollmentId, semZap.numero).catch((err) => {
            logger.warn({ ...alvo, err }, "[flow] não deu para marcar o número sem WhatsApp no cadastro");
            return false;
          })
        : false;
      const legivel = descreverFalhaDeEnvio(msg) + (marcado ? " Número marcado no cadastro." : "");
      const result: NodeResult = { nextNodeId: proximoDoEnvio(node), skipped: true, motivo: legivel };
      const prox = await concluirPasso({ ...alvo, result, status: "skipped", error: legivel });
      if (prox) await scheduleStep(enrollmentId, prox.nodeId, prox.round, prox.delayMs);
      return "pulado";
    }
    // Não saiu e vale tentar de novo: o MESMO nó, round novo, com backoff.
    const falhasAnteriores = await prisma.flowStepExecution.count({
      where: { enrollmentId, nodeId, status: "failed", error: { startsWith: PREFIXO_NAO_SAIU } },
    });
    await prisma.flowStepExecution.updateMany({
      where: alvo,
      data: { status: "failed", error: `${PREFIXO_NAO_SAIU} ${msg}`.slice(0, 500), finishedAt: new Date() },
    });
    if (falhasAnteriores >= BACKOFF_ENVIO_MS.length) {
      await prisma.enrollment.update({ where: { id: enrollmentId }, data: { status: "failed", nextRunAt: null } });
      return "falhou";
    }
    await repetirNoMesmoNo(alvo, falhasAnteriores);
    return "reagendado";
  }

  if (marca === "enviando" && EFEITO_EXTERNO.has(node.tipo)) {
    await segurarParaRevisao(alvo, `resultado incerto (caiu durante o envio): ${msg}`);
    return "segurado";
  }

  // Nada saiu: libera o claim para o retry do BullMQ refazer o passo do zero.
  await prisma.flowStepExecution.deleteMany({ where: { ...alvo, status: "running" } });
  return "relancar";
}

/**
 * Retry do MESMO job que achou o claim "running" (o processo caiu no meio do
 * passo: SIGKILL, OOM). Decide pela marca de fase. Devolve true se tratou (o
 * handler sai); false = seguro reexecutar o passo.
 */
export async function retomarPassoInterrompido(input: {
  enrollmentId: string;
  nodeId: string;
  round: number;
  node: SnapshotNode;
  result: unknown;
}): Promise<boolean> {
  const alvo = { enrollmentId: input.enrollmentId, nodeId: input.nodeId, round: input.round };
  if (!EFEITO_EXTERNO.has(input.node.tipo)) return false;
  const marca = lerMarcaDeEnvio(input.result);
  if (marca === "enviado") {
    await avancarEnvioFeito(alvo, input.node);
    return true;
  }
  if (marca === "enviando") {
    await segurarParaRevisao(alvo, "retomada insegura: o processo caiu durante o envio (pode ter saído)");
    return true;
  }
  return false; // caiu antes de chamar o canal: seguro refazer
}
