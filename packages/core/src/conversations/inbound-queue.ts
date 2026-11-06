import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import {
  analisarEvolutionInbound,
  parseEvolutionConnectionEvent,
  parseEvolutionStatusUpdate,
  tipoDaMensagemEvolution,
  type InboundMessage,
  type MessageStatusUpdate,
} from "@crmagro/channels";
import { redisEstado } from "../shared/redis-cache";
import { logger } from "../logger/index";

/**
 * Fila `inbound` — a mensagem recebida nunca se perde (auditoria INT-01, DP-03).
 *
 * Antes: o webhook respondia 200 na hora e processava em `after()` no WEB. Se o
 * processamento falhasse (pgbouncer cheio, deploy, restart por memória), a
 * mensagem sumia — a Evolution achava que tinha entregue e nunca reenviava.
 *
 * Agora: o webhook só GRAVA na fila (Redis, ~ms) e então responde 200. Se nem
 * isso der (Redis fora), responde 503 e a Evolution reenvia. O WORKER processa
 * com retry exponencial. O `jobId` determinístico descarta a reentrega da mesma
 * mensagem enquanto o job existir; o índice único no banco cobre o resto.
 */

export const INBOUND_QUEUE = "inbound";

export type InboundJob =
  // `recebidoEm` (ms): quando o webhook chegou — base da hora da mensagem
  // (INT-16, `dataDaMensagem`). Opcional: jobs antigos na fila não têm.
  | { kind: "message"; msg: InboundMessage; recebidoEm?: number }
  | { kind: "status"; update: MessageStatusUpdate }
  // Item 1.6: a instância caiu/voltou; QR novo durante a (re)conexão.
  | { kind: "conexao"; instance: string; state: string }
  | { kind: "qr"; instance: string; qrBase64: string };

/** Tempo máximo para gravar na fila antes de responder 503. */
const ENQUEUE_TIMEOUT_MS = 3000;

let conexao: Redis | null = null;
let fila: Queue | null = null;

function queue(): Queue {
  if (!fila) {
    // Produtor: 1 tentativa por comando — com o Redis fora, falha rápido e a
    // rota devolve 503 (a Evolution reenvia) em vez de segurar a requisição.
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: ENQUEUE_TIMEOUT_MS });
    conexao.on("error", (err) => logger.warn({ err: err.message }, "[inbound] erro na conexão Redis"));
    fila = new Queue(INBOUND_QUEUE, { connection: conexao });
  }
  return fila;
}

/** jobId sem ":" (o BullMQ recusa) — instância + id da mensagem no WhatsApp. */
export function inboundJobId(job: InboundJob): string | undefined {
  if (job.kind === "message") {
    if (!job.msg.providerMessageId) return undefined;
    return `in_${job.msg.instance ?? "sem-instancia"}_${job.msg.providerMessageId}`;
  }
  if (job.kind === "conexao" || job.kind === "qr") return undefined; // cada evento conta
  const u = job.update;
  return `st_${u.providerMessageId}_${u.status ?? "x"}_${u.errorCode ?? "x"}`;
}

/**
 * Resistência a banco fora (auditoria do #56): antes eram 8 tentativas com
 * espera exponencial de 5 s — ~21 min no total. Um Supabase fora por 30 min
 * perdia DE VEZ toda mensagem recebida na janela (a Evolution já tinha ouvido
 * 200 e não reenvia). Agora: 20 tentativas, espera dobrando a partir de 5 s e
 * limitada a 10 min (~2,5 h no total), e o reprocesso periódico abaixo.
 * O processamento é idempotente (índice único + P2002), então repetir é seguro.
 */
export const INBOUND_TENTATIVAS = 20;
export const INBOUND_BACKOFF = "inbound";

/** Espera antes da tentativa N+1 (N = tentativas já feitas). Worker: `settings.backoffStrategy`. */
export function esperaDoInbound(tentativasFeitas: number): number {
  return Math.min(5000 * 2 ** Math.max(0, tentativasFeitas - 1), 10 * 60_000);
}

/** Grava o job na fila. Lança se não conseguir em 3 s (quem chama responde 503). */
export async function enqueueInbound(job: InboundJob): Promise<void> {
  const jobId = inboundJobId(job);
  const add = queue().add(job.kind, job, {
    ...(jobId ? { jobId } : {}),
    attempts: INBOUND_TENTATIVAS,
    backoff: { type: INBOUND_BACKOFF },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("fila inbound indisponível (timeout)")), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([add, limite]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Contador de descartes por tipo (INT-17): o que chega e NÃO vira mensagem.
// ---------------------------------------------------------------------------
const descartes = new Map<string, number>();

/** Descartes de propósito (não são conversa): só em debug, para não lotar o log. */
const DESCARTE_ESPERADO = new Set(["grupo", "nao_conversa"]);

function registrarDescarte(motivo: string, tipo: string): void {
  const chave = `${motivo}:${tipo}`;
  const n = (descartes.get(chave) ?? 0) + 1;
  descartes.set(chave, n);
  const nivel = DESCARTE_ESPERADO.has(motivo) ? "debug" : "info";
  logger[nivel]({ motivo, tipo, total: n }, "[inbound] mensagem descartada");
}

/** Contagem de descartes por `motivo:tipo` deste processo (diagnóstico e teste). */
export function descartesDoInbound(): Record<string, number> {
  return Object.fromEntries(descartes);
}

export type WebhookDecision = { status: number; body: Record<string, unknown> };

/**
 * Decide a resposta do webhook do WhatsApp (a rota só autentica e repassa).
 * Recibo (messages.update) e mensagem (messages.upsert) vão para a fila.
 * `enqueue` é injetável nos testes.
 */
export async function acceptWhatsAppWebhook(
  body: unknown,
  enqueue: (job: InboundJob) => Promise<void> = enqueueInbound,
): Promise<WebhookDecision> {
  // Conexão (item 1.6): caiu/voltou, QR novo.
  const conexao = parseEvolutionConnectionEvent(body);
  if (conexao) {
    const job: InboundJob =
      conexao.tipo === "conexao"
        ? { kind: "conexao", instance: conexao.instance, state: conexao.state }
        : { kind: "qr", instance: conexao.instance, qrBase64: conexao.qrBase64 };
    try {
      await enqueue(job);
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "[inbound] evento de conexão não enfileirado — 503");
      return { status: 503, body: { ok: false, error: "fila indisponível" } };
    }
    return { status: 200, body: { ok: true, kind: job.kind } };
  }

  const statusUpdate = parseEvolutionStatusUpdate(body);
  if (statusUpdate) {
    try {
      await enqueue({ kind: "status", update: statusUpdate });
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "[inbound] recibo não enfileirado — 503");
      return { status: 503, body: { ok: false, error: "fila indisponível" } };
    }
    return { status: 200, body: { ok: true, kind: "status" } };
  }

  const r = analisarEvolutionInbound(body);
  if (!r.ok) {
    registrarDescarte(r.motivo, tipoDaMensagemEvolution(body));
    return { status: 200, body: { ok: true, skipped: "unparseable", motivo: r.motivo } };
  }
  const msg = r.msg;
  if (msg.text === null && !msg.media) {
    registrarDescarte("empty", tipoDaMensagemEvolution(body));
    return { status: 200, body: { ok: true, skipped: "empty" } };
  }
  try {
    await enqueue({ kind: "message", msg, recebidoEm: Date.now() });
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[inbound] mensagem não enfileirada — 503");
    return { status: 503, body: { ok: false, error: "fila indisponível" } };
  }
  return { status: 200, body: { ok: true } };
}

// Falha de INFRAESTRUTURA (banco/rede fora) — vale reprocessar quando voltar.
// `processInboundJob` marca com o prefixo `InfraIndisponivel:` (o Prisma não
// põe o código P1001… no texto); a regex antiga fica para jobs de antes.
// Erro de código/payload não entra: repetiria para sempre.
const FALHA_DE_INFRA =
  /^InfraIndisponivel:|Can't reach database|timed out|Unable to start a transaction|Server has closed the connection|Error in PostgreSQL connection|Engine is not yet connected|Connection terminated|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;
const MAX_REPROCESSOS = 3;
// Só mensagem e recibo: um `conexao`/`qr` reprocessado horas depois aplicaria
// estado VELHO (um "close" antigo pausaria a conta que já voltou; QR vencido).
const REPROCESSAVEIS = new Set(["message", "status"]);

/**
 * Reprocessa as mensagens recebidas que esgotaram as tentativas por falha de
 * infraestrutura nas últimas 24 h (auditoria do #56). No máximo 3 vezes por
 * job (contador no Redis). Roda no worker primário a cada 10 min — quando o
 * banco volta, a mensagem entra; com o banco ainda fora, falha de novo e espera
 * a próxima rodada.
 */
export async function reprocessarInboundFalhos(
  agora = Date.now(),
  fila: Pick<Queue, "getJobs"> = queue(),
): Promise<{ reprocessados: number }> {
  const falhos = await fila.getJobs(["failed"], 0, 500);
  const redis = redisEstado();
  let reprocessados = 0;
  for (const job of falhos) {
    if (!job?.id || !job.finishedOn || agora - job.finishedOn > 24 * 3_600_000) continue;
    if (!REPROCESSAVEIS.has(job.name)) continue;
    if (!FALHA_DE_INFRA.test(job.failedReason ?? "")) continue;
    try {
      // Contador e prazo num passo só (mesma lição do #96).
      const chave = `inbound:reprocesso:${job.id}`;
      const [[, vezes]] = (await redis.multi().incr(chave).expire(chave, 48 * 3600, "NX").exec()) as [[unknown, number], unknown];
      if (vezes > MAX_REPROCESSOS) continue;
      // `resetAttemptsMade`: sem isto o job voltava com as 20 tentativas já
      // gastas e falhava na 1ª, sem espera — cada reprocesso valia 1 tentativa.
      await job.retry("failed", { resetAttemptsMade: true });
      reprocessados++;
    } catch (e) {
      // Job removido ou já reprocessado por outro processo: segue para o próximo.
      logger.warn({ jobId: job.id, err: e instanceof Error ? e.message : String(e) }, "[inbound] reprocesso de um job falhou");
    }
  }
  if (reprocessados) logger.warn({ reprocessados }, "[inbound] mensagens que falharam por banco/rede voltaram para a fila");
  return { reprocessados };
}

/** Mensagens recebidas NÃO gravadas (tentativas esgotadas) na última hora — health/alerta. */
export async function inboundFalhosUltimaHora(agora = Date.now(), fila: Pick<Queue, "getJobs"> = queue()): Promise<number> {
  const falhos = await fila.getJobs(["failed"], 0, 500);
  return falhos.filter((j) => j?.finishedOn && agora - j.finishedOn <= 3_600_000).length;
}
