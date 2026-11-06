import { randomUUID } from "node:crypto";
import { db } from "@crmagro/db";
import { ChannelSendFailed, isChannelSendFailed, isSessaoSocialInvalida } from "@crmagro/channels";
import { devolverCotaDeEnvio } from "../channels-limit/service";
import { logger } from "../logger/index";
import { relaySocialSend, type ResultadoRelaySocial } from "../relay/hub";
import type { SocialSendSpec } from "../relay/jobs";
import { redisEstado } from "../shared/redis-cache";
import { usernameEsperadoDaConta } from "../social/service";
import { concluirPasso } from "./avanco";
import { aplicarStatusDoFluxo } from "./controle";
import { tratarFalhaDoPasso, retomarPassoInterrompido, segurarParaRevisao, type DesfechoDaFalha } from "./falhas";
import { lerMarcaDeEnvio, marcarFaseDoPasso } from "./fase-envio";
import { enfileirarEnvioSocial, type EnvioSocialJob } from "./fila-social";
import { devolverEnvioAoContato } from "./limites";
import { scheduleStep } from "./queue";
import type { SnapshotNode } from "./schema";
import { lerNoDoSnapshot } from "./snapshot";
import { snapshotDaInscricao } from "./versao";

/**
 * Envio social seguro (item 1.8 — INT-07/MF-11, INT-08, INT-09, MF-10).
 *
 * O executor resolve conta, destino e texto e devolve a diretiva `social`; o
 * handler do motor chama `entregarEnvioSocial`, que deixa a inscrição ESPERANDO
 * (`waitingFor = "social"`) e põe o DM na fila `social`. O worker primário
 * consome essa fila com `processarEnvioSocial`: um DM por conta de cada vez
 * (trava no Redis), marca de fase antes/depois (item 1.2) e só então o passo
 * avança. Qualquer desfecho incerto SEGURA para revisão — nunca reenvia.
 */

export const MARCA_ENVIO_SOCIAL = "social";
/** Rede de segurança: sem notícia do DM em 30 min, a varredura de órfãs olha. */
const REDE_DE_SEGURANCA_MS = 30 * 60_000;
/** Trava por conta: cobre extensão (90 s + 60 s de graça) ou Playwright. */
const TRAVA_CONTA_MS = 5 * 60_000;
/** DM parado na fila além disto é segurado (mesma régua do FLOW_STALE_HOURS). */
const VENCIDO_MS = Number(process.env.FLOW_STALE_HOURS ?? 6) * 3_600_000;

type Alvo = { enrollmentId: string; nodeId: string; round: number };

/**
 * Handler do motor → o DM vai para a fila `social` e a inscrição espera. O
 * ponteiro fica no passo (mesmo nó/round): se o job sumir, a varredura de
 * órfãs reagenda o passo e a marca de fase decide o que fazer.
 */
export async function entregarEnvioSocial(input: {
  enrollmentId: string;
  nodeId: string;
  round: number;
  teamId: string;
  contactId: string;
  social: { accountId: string; network: "instagram" | "linkedin"; to: string; text: string };
  agora?: Date;
}): Promise<void> {
  const agora = input.agora ?? new Date();
  await db().enrollment.update({
    where: { id: input.enrollmentId },
    data: {
      status: "waiting",
      currentNodeId: input.nodeId,
      currentRound: input.round,
      nextRunAt: new Date(agora.getTime() + REDE_DE_SEGURANCA_MS),
      waitingFor: MARCA_ENVIO_SOCIAL,
      waitingUntil: null,
    },
  });
  await enfileirarEnvioSocial({
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    round: input.round,
    teamId: input.teamId,
    contactId: input.contactId,
    ...input.social,
    enfileiradoEm: agora.getTime(),
  });
}

/** Quem de fato manda o DM (extensão → Playwright). Injetado pelo worker. */
export type EnviarDmSocial = (p: {
  teamId: string;
  accountId: string;
  network: "instagram" | "linkedin";
  to: string;
  text: string;
}) => Promise<{ providerMessageId: string }>;

export type DesfechoSocial = "enviado" | "descartado" | "fora_do_ar" | "vencido" | "ocupado" | DesfechoDaFalha;

/** A cota do número e o limite do contato voltam quando o DM certamente não saiu. */
async function devolverCotas(job: EnvioSocialJob): Promise<void> {
  await devolverCotaDeEnvio(job.accountId).catch(() => {});
  await devolverEnvioAoContato(job.contactId).catch(() => {});
}

async function travarConta(accountId: string): Promise<string | null> {
  const token = randomUUID();
  const ok = await redisEstado().set(`social:trava:${accountId}`, token, "PX", TRAVA_CONTA_MS, "NX");
  return ok ? token : null;
}

async function liberarConta(accountId: string, token: string): Promise<void> {
  try {
    const r = redisEstado();
    const key = `social:trava:${accountId}`;
    if ((await r.get(key)) === token) await r.del(key);
  } catch {
    // expira sozinha
  }
}

/**
 * Processa UM DM da fila `social`. Roda no contexto do time (runAsSystem).
 * Devolve "ocupado" quando outra mensagem da MESMA conta está saindo — o worker
 * adia o job alguns segundos. Erro de infraestrutura ANTES da marca "enviando"
 * é relançado (retry do BullMQ); depois dela, o desfecho é tratado aqui.
 */
export async function processarEnvioSocial(
  job: EnvioSocialJob,
  enviar: EnviarDmSocial,
  opts: { agora?: Date; vencidoMs?: number } = {},
): Promise<DesfechoSocial> {
  const alvo: Alvo = { enrollmentId: job.enrollmentId, nodeId: job.nodeId, round: job.round };
  const agora = opts.agora ?? new Date();
  const prisma = db();
  const enr = await prisma.enrollment.findUnique({
    where: { id: job.enrollmentId },
    select: {
      status: true,
      waitingFor: true,
      currentNodeId: true,
      currentRound: true,
      flowSnapshot: true,
      flowVersionId: true,
      snapshotVersion: true,
      flow: { select: { status: true } },
    },
  });
  const passo = await prisma.flowStepExecution.findFirst({ where: alvo, select: { status: true, result: true } });
  const marca = lerMarcaDeEnvio(passo?.result);
  const esperando =
    !!enr &&
    enr.status === "waiting" &&
    enr.waitingFor === MARCA_ENVIO_SOCIAL &&
    enr.currentNodeId === job.nodeId &&
    enr.currentRound === job.round;

  // A inscrição saiu deste passo (parar tudo, redirecionar, fluxo arquivado):
  // o DM não sai. Sem marca de fase, nada foi enviado — devolve a cota.
  if (!esperando) {
    if (!marca) {
      await devolverCotas(job);
      await prisma.flowStepExecution.updateMany({
        where: { ...alvo, status: "running" },
        data: { status: "skipped", error: "DM social cancelado: a inscrição saiu deste passo", finishedAt: agora },
      });
    }
    return "descartado";
  }

  // Grafo da versão (inscrição nova, em cache) ou o próprio flowSnapshot (antiga) — item 2.7.
  const leitura = lerNoDoSnapshot(await snapshotDaInscricao(enr), job.nodeId, enr.snapshotVersion);
  if (!leitura.ok) {
    await devolverCotas(job);
    await segurarParaRevisao(alvo, `DM social: ${leitura.erro}`);
    return "descartado";
  }
  const node: SnapshotNode = leitura.node;

  // Retry depois de marcar a fase: a marca decide (enviado avança, enviando
  // segura). Nunca reenvia.
  if (marca && (await retomarPassoInterrompido({ ...alvo, node, result: passo?.result }))) {
    return marca === "enviado" ? "enviado" : "segurado";
  }

  // Fluxo pausado/arquivado enquanto o DM esperava na fila (item 1.5).
  if (enr.flow.status !== "active") {
    await devolverCotas(job);
    await aplicarStatusDoFluxo({ ...alvo, flowStatus: enr.flow.status });
    return "fora_do_ar";
  }

  // Fila represada: DM de horas atrás sai fora de contexto — segura.
  const idade = agora.getTime() - job.enfileiradoEm;
  if (idade > (opts.vencidoMs ?? VENCIDO_MS)) {
    await devolverCotas(job);
    await segurarParaRevisao(alvo, `DM social ficou ${Math.round(idade / 3_600_000)} h na fila e foi segurado para revisão`);
    return "vencido";
  }

  const token = await travarConta(job.accountId);
  if (!token) return "ocupado";
  try {
    // Fora do try do envio: erro de banco aqui = nada saiu → retry do job.
    await marcarFaseDoPasso(alvo, { fase: "enviando" });
    try {
      const r = await enviar({ teamId: job.teamId, accountId: job.accountId, network: job.network, to: job.to, text: job.text });
      await marcarFaseDoPasso(alvo, { fase: "enviado", enviado: true, providerMessageId: r.providerMessageId });
      const proximo = await concluirPasso({
        ...alvo,
        result: {
          nextNodeId: "nextNodeId" in node ? (node.nextNodeId ?? null) : null,
          sideEffects: { lastOutboundAt: new Date() },
        },
      });
      if (proximo) await scheduleStep(job.enrollmentId, proximo.nodeId, proximo.round, proximo.delayMs);
      return "enviado";
    } catch (erro) {
      if (isChannelSendFailed(erro) && erro.outcome === "not_sent") await devolverCotas(job);
      const desfecho = await tratarFalhaDoPasso({ ...alvo, node, erro });
      logger.warn(
        { ...alvo, network: job.network, desfecho, err: erro instanceof Error ? erro.message : String(erro) },
        "[social] DM não confirmado",
      );
      if (desfecho === "relancar") throw erro;
      return desfecho;
    }
  } finally {
    await liberarConta(job.accountId, token);
  }
}

/**
 * Códigos de erro da extensão (apps/extension/background.js). Os de destino
 * são definitivos (repetir não adianta); `nao_confirmado` pode ter saído; o
 * resto (conta trocada no navegador, limite da extensão, aba que não abriu)
 * certamente não saiu e vale repetir.
 */
const ERROS_DEFINITIVOS = new Set(["destino_invalido", "perfil_nao_encontrado", "sem_botao_mensagem", "conversa_errada", "url_not_allowed"]);

function falhaDaExtensao(codigo: string): ChannelSendFailed {
  if (codigo === "nao_confirmado") {
    return new ChannelSendFailed("extensão: não confirmou a mensagem na conversa (pode ter saído)", "unknown", false);
  }
  return new ChannelSendFailed(`extensão: ${codigo}`, "not_sent", !ERROS_DEFINITIVOS.has(codigo));
}

/**
 * Manda o DM: pela EXTENSÃO logada na conta (IP residencial) e, só quando é
 * certo que ela não pegou o job, pelo Playwright no worker. Resultado incerto
 * da extensão NUNCA cai no Playwright (antes: DM duplicado — MF-11).
 * Sessão deslogada no Playwright pausa a conta (volta ao reconectar).
 */
export async function enviarDmSocial(
  p: Parameters<EnviarDmSocial>[0],
  peloNavegador: (p: { accountId: string; to: string; text: string }) => Promise<{ providerMessageId: string }>,
  relay: (teamId: string, spec: SocialSendSpec) => Promise<ResultadoRelaySocial> = relaySocialSend,
): Promise<{ providerMessageId: string }> {
  const expectedUsername = await usernameEsperadoDaConta(p.accountId);
  const r = await relay(p.teamId, { network: p.network, to: p.to, text: p.text, accountId: p.accountId, expectedUsername });
  if (r.ok) {
    logger.info({ network: p.network, teamId: p.teamId }, "[social] enviado pela extensão (IP residencial)");
    return { providerMessageId: `relay-${r.jobId}` };
  }
  const codigo = r.error ?? "falha";
  if (codigo === "incerto") {
    throw new ChannelSendFailed("extensão pegou o DM e não respondeu a tempo (pode ter saído)", "unknown", false);
  }
  if (codigo !== "no_agent" && codigo !== "timeout" && codigo !== "relay_indisponivel") throw falhaDaExtensao(codigo);

  logger.warn({ network: p.network, teamId: p.teamId, motivo: codigo }, "[social] sem extensão com a conta — Playwright (IP do datacenter)");
  try {
    return await peloNavegador({ accountId: p.accountId, to: p.to, text: p.text });
  } catch (e) {
    if (isSessaoSocialInvalida(e)) {
      await db().channelAccount.updateMany({ where: { id: p.accountId }, data: { status: "error", paused: true } });
      logger.warn({ accountId: p.accountId }, "[social] sessão deslogada — conta pausada até reconectar");
    }
    throw e;
  }
}
