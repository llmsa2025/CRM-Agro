import { Worker, DelayedError, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "@crmagro/config";
import { basePrisma, runAsSystem, conectarBancoApp, sondarBancoApp, type SondaBancoApp } from "@crmagro/db";
import {
  type StepJob,
  type TranscriptionJob,
  logger,
  pollAllEmailInboxes,
  gcPendingWhatsAppOnboardings,
  processInboundJob,
  varrerInscricoesOrfas,
  varrerSeguradasComFluxoNoAr,
  executarRetencao,
  verificarConexoesWhatsApp,
  INBOUND_QUEUE,
  esperaDoInbound,
  reprocessarInboundFalhos,
  type InboundJob,
  SOCIAL_QUEUE,
  processarEnvioSocial,
  STORAGE_LIMPEZA_QUEUE,
  processarLimpezaDeMidia,
  CAMPAIGN_QUEUE,
  varrerCampanhasParadas,
  type CampaignJob,
  type LimpezaDeMidiaJob,
  runHealthChecks,
  alertarSeDegradado,
  WORKER_HEARTBEAT_PREFIXO,
  type EnvioSocialJob,
  IMPORT_QUEUE,
  processarImportacao,
  marcarImportacaoFalhou,
  type ImportacaoJob,
  GEO_QUEUE,
  processarJobGeo,
  agendarBackfillGeo,
  type JobGeo,
  enviarLembretesDaAgenda,
  AGENDA_GOOGLE_QUEUE,
  processarJobAgendaGoogle,
  agendarManutencaoAgendaGoogle,
  type JobAgendaGoogle,
  WHATSAPP_HISTORY_QUEUE,
  type WhatsAppHistoryJob,
  processarHistoricoWhatsApp,
  agendarHistoricosWhatsApp,
  EMAIL_ENTRADA_QUEUE,
  processarEmailEncaminhado,
  preencherHashDoCpf,
  type EmailEncaminhadoJob,
  AGRO_QUEUE,
  processarBlocoAgro,
  fecharBlocoAgroComFalha,
  type BlocoAgro,
} from "@crmagro/core";
import { handleStepJob } from "./handler";
import { handleTranscriptionJob } from "./transcription-handler";
import { verifySocialAccountsOnce, sendSocialDM } from "./social";
import { handleCaptureJob } from "./capture-handler";
import { handleCampaignJob } from "./campaign-handler";
import { matarChromiumOrfao } from "./chromium";
import { handleAiJob } from "./ai-handler";
import type { CaptureJob, AiChatJob } from "@crmagro/core";

/**
 * Worker do motor de fluxos — processo contínuo (NÃO serverless: BullMQ Worker
 * faz long-poll no Redis). Consome a fila "flow", executando um passo por job.
 *
 * Falhas: BullMQ retenta (attempts:5, backoff exponencial configurado no
 * `scheduleStep`). Ao exaurir, o evento `failed` marca o enrollment como failed
 * (dead-letter virtual = set `failed` do BullMQ; painel de observabilidade futuro).
 */

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
// Sem ouvinte, o ioredis despeja "Unhandled error event" (EPIPE ao reconectar)
// com stack inteira no log. A reconexão é automática; aqui só registramos.
connection.on("error", (err) => {
  logger.warn({ err: err.message }, "[worker] redis: erro de conexão (reconectando)");
});

// ---------------------------------------------------------------------------
// Guardas de processo. Uma falha isolada (ex.: 1 conta de e-mail com senha
// errada) NÃO pode derrubar o motor inteiro — foi o que gerou 92 mil reinícios.
// - Promise rejeitada sem catch: registra e segue (é sempre um caso isolado).
// - Exceção síncrona não tratada: registra e sai com código 1 — o estado do
//   processo é incerto; o pm2 reinicia com backoff (ecosystem.config.cjs).
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "[worker] promise rejeitada sem tratamento (ignorada)");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "[worker] exceção não tratada — encerrando p/ o pm2 reiniciar");
  process.exit(1);
});

// Escala horizontal (auditoria, item 3): o consumo das filas `flow`/`transcription`
// é seguro em VÁRIOS processos worker (BullMQ distribui os jobs; a idempotência é
// garantida por FlowStepExecution @@unique e a cota por conta por incremento
// atômico). Mas as tarefas SINGLETON (poll de e-mail, verificação social) e o
// worker de `capture` (scraping, concorrência 1 — 2 scrapes juntos = risco de ban)
// NÃO podem rodar em todos os processos, senão duplicam. WORKER_PRIMARY (default
// true) designa o ÚNICO processo que roda essas tarefas. Para rodar N workers:
// suba 1 com WORKER_PRIMARY=true e os demais com WORKER_PRIMARY=false.
const isPrimary = (process.env.WORKER_PRIMARY ?? "true") !== "false";

// Histórico em fila própria: não bloqueia mensagens novas nem o motor.
const whatsappHistoryWorker = new Worker<WhatsAppHistoryJob>(
  WHATSAPP_HISTORY_QUEUE,
  (job) => processarHistoricoWhatsApp(job.data, () => closing),
  { connection, concurrency: 1 },
);
whatsappHistoryWorker.on("failed", (job, err) => {
  logger.warn({ accountId: job?.data.accountId, err: err.message }, "[wa-history] importação será retomada");
});

async function historicosWhatsAppOnce() {
  try {
    await agendarHistoricosWhatsApp();
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[wa-history] falha ao agendar históricos");
  }
}

const worker = new Worker(
  "flow",
  async (job: Job<StepJob>, token?: string) => {
    // plannedAt = quando o passo DEVERIA rodar (criação + delay agendado). O
    // handler segura envios muito atrasados (ver PASSO_VENCIDO_MS).
    // Reagendamento (varredura/ponteiro) traz o horário ORIGINAL em data.plannedAt.
    const r = await handleStepJob(job.id, job.data, { plannedAt: job.data.plannedAt ?? job.timestamp + (job.opts.delay ?? 0) });
    // Sem vez do time (item 1.9): volta à fila atrasado, sem gastar tentativa.
    if (r?.adiarMs) {
      await job.moveToDelayed(Date.now() + r.adiarMs, token);
      throw new DelayedError();
    }
  },
  {
    connection,
    stalledInterval: 30_000,
    maxStalledCount: 1,
    // Concorrência: quantos passos o worker processa em paralelo. Passos são
    // majoritariamente I/O (DB, HTTP dos canais), então dá pra ter bem mais que
    // cores. Ajustável por env.
    concurrency: Number(process.env.FLOW_CONCURRENCY ?? 12),
    // Teto AGREGADO de passos/min entre TODAS as inscrições — rede de segurança
    // de INFRA (evita rajada que satura worker/Redis/DB), NÃO o controle de ritmo. A
    // justiça ENTRE TIMES é o balde por time no handler (item 1.9,
    // FLOW_STEPS_PER_MINUTE_PER_TEAM, padrão 120).
    //
    // O controle de ritmo real é a cota POR CONTA/número (consumeSendQuota: warmup + teto
    // diário + pause, com incremento atômico), aplicada nos nós de envio. Por isso
    // o teto global sobe de 20 (que travava tudo com 1 número) para 600/min —
    // deixa de ser gargalo. Ajustável por env conforme a saúde na mão.
    limiter: {
      max: Number(process.env.FLOW_STEPS_PER_MINUTE ?? 600),
      duration: 60_000,
    },
  },
);

// Último job processado (item 1.10): vai no heartbeat — processo vivo com a
// fila parada aparece. `completed` em debug: em info eram ~860 mil linhas/dia
// a 600/min, e os erros se afogavam no logrotate.
let ultimoJobEm: string | null = null;
worker.on("completed", (job) => {
  ultimoJobEm = new Date().toISOString();
  logger.debug({ jobId: job.id }, "[flow] job concluído");
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  ultimoJobEm = new Date().toISOString();
  logger.error({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, "[flow] job falhou");
  const attempts = job.opts.attempts ?? 1;
  // Job que NÃO vai ser retentado: tentativas esgotadas OU estourou o stall
  // (2 quedas do processo no mesmo job — OOM, kill do deploy). Antes só o
  // primeiro caso marcava a inscrição; o stall a deixava "active" órfã (MF-01).
  const definitivo = job.attemptsMade >= attempts || /stalled/i.test(job.failedReason ?? err.message);
  if (definitivo) {
    const { enrollmentId, nodeId, round } = job.data;
    try {
      const enr = await basePrisma.enrollment.update({
        where: { id: enrollmentId },
        data: { status: "failed", nextRunAt: null },
        select: { teamId: true },
      });
      // O erro real vai para o log do fluxo (aba Logs), não só para o pm2.
      // upsert: o tratamento de falha (item 1.2) apaga o claim antes de cada
      // retry, então na última tentativa pode não haver linha para atualizar.
      const erro = err.message.slice(0, 500);
      const existente = await basePrisma.flowStepExecution.findUnique({
        where: { enrollmentId_nodeId_round: { enrollmentId, nodeId, round } },
        select: { status: true },
      });
      if (!existente) {
        await basePrisma.flowStepExecution.create({
          data: { teamId: enr.teamId, enrollmentId, nodeId, round, jobId: job.id ?? null, status: "failed", error: erro, finishedAt: new Date() },
        });
      } else if (existente.status !== "done") {
        await basePrisma.flowStepExecution.update({
          where: { enrollmentId_nodeId_round: { enrollmentId, nodeId, round } },
          data: { status: "failed", error: erro, finishedAt: new Date() },
        });
      }
    } catch {
      // enrollment pode ter sumido — ignora.
    }
  }
});

// ---------------------------------------------------------------------------
// Worker de transcrição de chamadas — fila "transcription".
// Consome jobs enfileirados por `scheduleTranscription` (webhook Voopi com
// recordingUrl). Cada job transcreve o áudio e gera um resumo via IA.
// ---------------------------------------------------------------------------

const transcriptionWorker = new Worker(
  "transcription",
  async (job: Job<TranscriptionJob>) => {
    await handleTranscriptionJob(job.id, job.data);
  },
  {
    connection,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  },
);

transcriptionWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "[transcription] job concluído");
});

transcriptionWorker.on("failed", (job, err) => {
  if (!job) return;
  logger.error({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, "[transcription] job falhou");
});

// Captação (Google Maps / Instagram) — scraping pesado, concorrência 1. SÓ no
// processo primário: 2 scrapes simultâneos (um por processo) = risco de ban/IP.
let captureWorker: Worker<CaptureJob> | null = null;
if (isPrimary) {
  captureWorker = new Worker(
    "capture",
    async (job: Job<CaptureJob>) => {
      await handleCaptureJob(job.data);
    },
    { connection, concurrency: 1, stalledInterval: 60_000, maxStalledCount: 1 },
  );

  captureWorker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "[captura] job concluído");
  });
  captureWorker.on("failed", (job, err) => {
    if (!job) return;
    logger.error({ jobId: job.id, err: err.message }, "[captura] job falhou");
  });
}

// DM social (Instagram/LinkedIn) — fila `social` (item 1.8, MF-10). SÓ no
// primário: um Chromium por vez (ver social.ts) e trava por conta no Redis. A
// concorrência > 1 é para esperar a extensão de um time (até ~150 s) sem
// segurar o DM de outro; o navegador continua um só. Conta ocupada (outro DM
// dela saindo) → o job volta para a fila em 20–40 s.
let socialWorker: Worker<EnvioSocialJob> | null = null;
if (isPrimary) {
  socialWorker = new Worker<EnvioSocialJob>(
    SOCIAL_QUEUE,
    async (job) => {
      const desfecho = await runAsSystem(job.data.teamId, () => processarEnvioSocial(job.data, sendSocialDM));
      if (desfecho === "ocupado") {
        await job.moveToDelayed(Date.now() + 20_000 + Math.round(Math.random() * 20_000), token);
        throw new DelayedError();
      }
      logger.info({ jobId: job.id, desfecho }, "[social] DM processado");
    },
    { connection, concurrency: Number(process.env.SOCIAL_CONCURRENCY ?? 2), stalledInterval: 60_000, maxStalledCount: 1 },
  );
  socialWorker.on("failed", (job, err) => {
    if (!job) return;
    // A inscrição fica esperando; a varredura de órfãs reagenda o passo e a
    // marca de fase decide (nunca reenvia um DM incerto).
    logger.error({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, "[social] job falhou");
  });
}

// Verificação do agro da base toda — fila `agro` (botão "Verificar agro" com "Selecionar todos do filtro"). SÓ no
// primário e UM bloco por vez: a segunda rodada consulta a foto na Evolution, e o respiro entre as consultas vale
// para o processo inteiro. O cadastro (sem rede) tem prioridade e passa na frente das fotos.
let agroWorker: Worker<BlocoAgro> | null = null;
if (isPrimary) {
  agroWorker = new Worker<BlocoAgro>(
    AGRO_QUEUE,
    async (job) => {
      const desfecho = await runAsSystem(job.data.teamId, () => processarBlocoAgro(job.data));
      logger.info({ jobId: job.id, fase: job.data.fase, desfecho }, "[agro] bloco processado");
    },
    { connection, concurrency: 1, stalledInterval: 60_000, maxStalledCount: 1 },
  );
  agroWorker.on("failed", (job, err) => {
    if (!job) return;
    const esgotou = job.attemptsMade >= (job.opts.attempts ?? 1);
    logger[esgotou ? "error" : "warn"](
      { jobId: job.id, attempt: job.attemptsMade, err: err.message },
      esgotou ? "[agro] tentativas esgotadas, bloco contado como falha" : "[agro] bloco falhou, vai tentar de novo",
    );
    if (esgotou) {
      void runAsSystem(job.data.teamId, () => fecharBlocoAgroComFalha(job.data)).catch(() => {});
    }
  });
}

// Assistente de IA — fila "ai". Roda o loop de tool-use (runAgent) FORA do event
// loop do web e faz streaming dos tokens de volta via Redis pub/sub. I/O-bound
// (API externa): roda em TODOS os processos worker (não é singleton). Concorrência
// ajustável — cada job pode durar até ~8×60s.
// ---------------------------------------------------------------------------
// Fila `inbound` (item 0.8, INT-01): mensagem/recibo do WhatsApp gravado pelo
// webhook. Roda em TODOS os workers (não é singleton). Falhou → até 20
// tentativas com espera limitada a 10 min (~2,5 h), e o reprocesso periódico
// (auditoria do #56) — a mensagem não se perde por uma queda do banco.
// ---------------------------------------------------------------------------
const inboundWorker = new Worker(
  INBOUND_QUEUE,
  async (job: Job<InboundJob>) => processInboundJob(job.data),
  {
    connection,
    concurrency: Number(process.env.INBOUND_CONCURRENCY ?? 4),
    stalledInterval: 30_000,
    maxStalledCount: 2,
    // Espera dobrando a partir de 5 s, limitada a 10 min (20 tentativas ≈ 2,5 h
    // de banco fora sem perder mensagem — auditoria do #56).
    // Só é chamada para o tipo custom `INBOUND_BACKOFF`; jobs antigos, com
    // "exponential", seguem a regra embutida do BullMQ.
    settings: { backoffStrategy: (tentativas: number) => esperaDoInbound(tentativas) },
  },
);
inboundWorker.on("failed", (job, err) => {
  if (!job) return;
  const esgotou = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger[esgotou ? "error" : "warn"](
    { jobId: job.id, attempt: job.attemptsMade, err: err.message },
    esgotou ? "[inbound] tentativas esgotadas — mensagem NÃO gravada" : "[inbound] falhou, vai tentar de novo",
  );
});

// Fila `email-entrada` (ficha E4): e-mail encaminhado pelo Gmail (Cloudflare → rota).
// Roda em TODOS os workers (não é singleton). O job é idempotente (dedupe pelo
// Message-ID), então repetir é seguro. O e-mail cru não fica guardado depois de
// processado nem depois de esgotar as tentativas (`removeOnComplete`/`removeOnFail`).
const emailEntradaWorker = new Worker<EmailEncaminhadoJob>(
  EMAIL_ENTRADA_QUEUE,
  async (job) => {
    const r = await processarEmailEncaminhado(job.data);
    logger.debug({ jobId: job.id, r }, "[email-entrada] processado");
  },
  { connection, concurrency: 2, stalledInterval: 30_000, maxStalledCount: 2 },
);
emailEntradaWorker.on("failed", (job, err) => {
  if (!job) return;
  const esgotou = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger[esgotou ? "error" : "warn"](
    { jobId: job.id, attempt: job.attemptsMade, err: err.message },
    esgotou ? "[email-entrada] tentativas esgotadas, e-mail descartado" : "[email-entrada] falhou, vai tentar de novo",
  );
});

// Limpeza de mídia do Storage (item 3.7, S15 — LGPD): contato excluído deixa
// as mídias na fila; o job (atrasado, com retry) apaga só o que ninguém mais
// usa. Roda em todos os workers (idempotente).
const limpezaWorker = new Worker<LimpezaDeMidiaJob>(
  STORAGE_LIMPEZA_QUEUE,
  async (job) => {
    const r = await processarLimpezaDeMidia(job.data);
    logger.info({ jobId: job.id, ...r }, "[storage] limpeza de mídia do contato excluído");
  },
  { connection, concurrency: 2, stalledInterval: 30_000, maxStalledCount: 1 },
);
limpezaWorker.on("failed", (job, err) => {
  if (!job) return;
  logger.warn({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, "[storage] limpeza de mídia falhou (vai tentar de novo)");
});

// Campanhas (produto §A.3) — fila `campaign`: montagem da lista e TICKS de
// envio (no máximo 1 envio por tick). Uma campanha por vez é garantido no core
// (corrente única + trava por campanha); campanhas diferentes em paralelo.
// Roda em todos os workers. `TickOcupado` volta para a fila com backoff.
const campaignWorker = new Worker<CampaignJob>(
  CAMPAIGN_QUEUE,
  async (job) => {
    const desfecho = await handleCampaignJob(job.data);
    logger.debug({ jobId: job.id, desfecho }, "[campanha] job processado");
  },
  {
    connection,
    concurrency: Number(process.env.CAMPAIGN_CONCURRENCY ?? 4),
    stalledInterval: 30_000,
    maxStalledCount: 1,
  },
);
campaignWorker.on("failed", (job, err) => {
  if (!job) return;
  const esgotou = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger[esgotou ? "error" : "warn"](
    { jobId: job.id, attempt: job.attemptsMade, err: err.message },
    esgotou ? "[campanha] tentativas esgotadas — corrente parada (retomar reinicia)" : "[campanha] job falhou, vai tentar de novo",
  );
});

// Importação de contatos em 4 passos (produto §C) — fila `import`. UMA por time
// por vez (trava no Redis dentro de `processarImportacao`): outra do mesmo time
// volta para a fila em 15–30 s. Times diferentes em paralelo até
// IMPORT_CONCURRENCY. Roda em todos os workers (a trava é por time).
const importWorker = new Worker<ImportacaoJob>(
  IMPORT_QUEUE,
  async (job) => {
    const desfecho = await runAsSystem(job.data.teamId, () => processarImportacao(job.data));
    if (desfecho === "ocupado") {
      await job.moveToDelayed(Date.now() + 15_000 + Math.round(Math.random() * 15_000), token);
      throw new DelayedError();
    }
    logger.info({ jobId: job.id, desfecho }, "[import] importação processada");
  },
  { connection, concurrency: Number(process.env.IMPORT_CONCURRENCY ?? 2), stalledInterval: 60_000, maxStalledCount: 1 },
);
importWorker.on("failed", (job, err) => {
  if (!job) return;
  const esgotou = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger[esgotou ? "error" : "warn"](
    { jobId: job.id, attempt: job.attemptsMade, err: err.message },
    esgotou ? "[import] tentativas esgotadas — importação marcada como falha" : "[import] falhou, vai retomar do último bloco",
  );
  if (esgotou) {
    void runAsSystem(job.data.teamId, () => marcarImportacaoFalhou(job.data.importJobId, err.message)).catch(() => {});
  }
});

// Geocodificação do Mapa (produto §B.2) — fila `geo`: backfill repetido dos
// contatos sem coordenada ou com endereço mudado. A vez do Nominatim (1 req/s)
// é global no Redis, então roda em qualquer worker; concorrência 1 (o backfill
// ainda tem trava própria).
const geoWorker = new Worker<JobGeo>(GEO_QUEUE, async (job) => processarJobGeo(job.data), {
  connection,
  concurrency: 1,
  stalledInterval: 60_000,
  maxStalledCount: 1,
});
geoWorker.on("failed", (job, err) => {
  if (!job) return;
  logger.warn({ jobId: job.id, err: err.message }, "[geo] job falhou");
});
void agendarBackfillGeo();

// Google Agenda + Meet (28/09) — fila `agenda-google`: sincronização de cada
// agenda conectada (aviso por push + polling de reserva) e a manutenção
// repetida a cada minuto (reenvio do que ficou pendente). Roda em qualquer
// worker: a trava por conexão (Redis) impede duas sincronizações da mesma agenda.
const agendaGoogleWorker = new Worker<JobAgendaGoogle>(AGENDA_GOOGLE_QUEUE, async (job) => processarJobAgendaGoogle(job.data), {
  connection,
  concurrency: 2,
  stalledInterval: 60_000,
  maxStalledCount: 1,
});
agendaGoogleWorker.on("failed", (job, err) => {
  if (!job) return;
  logger.warn({ jobId: job.id, err: err.message }, "[agenda-google] job falhou");
});
void agendarManutencaoAgendaGoogle();

const aiWorker = new Worker(
  "ai",
  async (job: Job<AiChatJob>) => {
    await handleAiJob(job.data);
  },
  { connection, concurrency: Number(process.env.AI_CONCURRENCY ?? 6), stalledInterval: 30_000, maxStalledCount: 1 },
);
aiWorker.on("failed", (job, err) => {
  if (!job) return;
  logger.error({ jobId: job.id, err: err.message }, "[ai] job falhou");
});

/** host:porta do Redis, sem a senha — a URL crua vazava credencial pro log. */
function redisTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "6379"}`;
  } catch {
    return "(REDIS_URL inválida)";
  }
}

// ---------------------------------------------------------------------------
// Poll de INBOUND de e-mail (IMAP) — tarefa periódica simples (um worker só, não
// precisa de fila BullMQ). Varre as caixas conectadas a cada EMAIL_POLL_MS e cria
// as respostas/bounces como mensagens. Best-effort: erro numa conta não derruba.
// ---------------------------------------------------------------------------
const EMAIL_POLL_MS = Number(process.env.EMAIL_POLL_MS ?? 120_000);

async function pollEmailOnce() {
  try {
    const r = await pollAllEmailInboxes();
    if (r.processed > 0) logger.info({ ...r }, "[email] inbound processado");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[email] falha no poll de inbound");
  }
}

// Verificação periódica das sessões sociais (Instagram/LinkedIn) — ajusta o
// status conectado/erro. Playwright roda só aqui no worker. Uma rodada a cada
// 6 h (item 1.8, INT-10), marcada no Redis: restart/deploy não refaz a rodada.
const SOCIAL_VERIFY_MS = Number(process.env.SOCIAL_VERIFY_MS ?? 6 * 60 * 60_000);

async function verifySocialOnce() {
  try {
    const vez = await connection.set("social:verificacao", String(Date.now()), "PX", SOCIAL_VERIFY_MS, "NX");
    if (!vez) return;
    await verifySocialAccountsOnce();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[social] falha na verificação");
  }
}

// Varredura de inscrições órfãs (item 0.9, MF-01): active/waiting com passo
// vencido há > 5 min e SEM job vivo no Redis → reagenda pelo ponteiro.
const SWEEP_MS = Number(process.env.FLOW_SWEEP_MS ?? 5 * 60_000);

async function sweepOnce() {
  try {
    await varrerInscricoesOrfas();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[flow] falha na varredura de órfãs");
  }
  // Inscrição segurada pela pausa com o fluxo NO AR: ninguém mais a retomaria (ver controle.ts).
  try {
    await varrerSeguradasComFluxoNoAr();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[flow] falha na varredura das seguradas pela pausa");
  }
}

// Retenção (item H.1 + job geral do item 2.7): a cada 6 h apaga rascunho de
// captação pendente há mais de 30 dias e cadastro com senha não confirmado
// (mais de 24 h, link vencido); 1× por dia, passos de inscrições encerradas há
// mais de 90 dias, rascunhos tratados > 30 dias e fatos de enriquecimento não
// aplicados > 180 dias (regras em core/retencao).
const RETENCAO_MS = 6 * 60 * 60_000;

async function retencaoOnce() {
  try {
    await executarRetencao();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[retencao] falha na limpeza");
  }
}

// Mensagem recebida que esgotou as tentativas por banco/rede fora volta para a
// fila quando a infraestrutura volta (auditoria do #56). No máx. 3× por job.
const INBOUND_REPROCESSO_MS = 10 * 60_000;

async function reprocessarInboundOnce() {
  try {
    await reprocessarInboundFalhos();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[inbound] falha ao reprocessar mensagens");
  }
}

// Campanha "enviando" sem tick vivo (auditoria do #125): rearma a corrente;
// parada repetida (> 3× em 1 h) pausa com motivo visível.
const CAMPANHA_VARREDURA_MS = 5 * 60_000;

async function varrerCampanhasOnce() {
  try {
    const r = await varrerCampanhasParadas();
    if (r.rearmadas || r.pausadas) logger.info({ ...r }, "[campanha] varredura de campanhas paradas");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[campanha] falha na varredura");
  }
}

// Alerta de saúde (item 1.10): fila atrasada, órfãs, Evolution fora → e-mail
// para a operação (ALERT_EMAILS), 1× a cada 30 min por motivo.
const SAUDE_MS = 5 * 60_000;

async function saudeOnce() {
  try {
    await alertarSeDegradado(await runHealthChecks());
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[alerta] falha ao checar a saúde");
  }
}

// Conexão do WhatsApp (item 1.6, INT-04): rede de segurança do evento
// connection.update — confere o estado de cada instância a cada 5 min.
const WA_CONEXAO_MS = 5 * 60_000;

async function conexoesOnce() {
  try {
    const r = await verificarConexoesWhatsApp();
    if (r.mudancas > 0) logger.info({ ...r }, "[whatsapp] estado de conexão atualizado");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[whatsapp] falha ao verificar conexões");
  }
}

// Lembrete da Agenda (produto §E): Web Push ao responsável quando `lembreteEm`
// chega. Idempotente no banco (lembreteEnviadoEm); a trava local só evita duas
// rodadas ao mesmo tempo neste processo.
const AGENDA_LEMBRETE_MS = 60_000;
let lembreteRodando = false;

async function lembretesAgendaOnce() {
  if (lembreteRodando) return;
  lembreteRodando = true;
  try {
    await enviarLembretesDaAgenda();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[agenda] falha nos lembretes");
  } finally {
    lembreteRodando = false;
  }
}

// GC do onboarding de WhatsApp (S4/INT-18): instância criada na Evolution e
// não confirmada em 15 min é apagada (senão acumulam órfãs na VPS).
const WA_GC_MS = 15 * 60_000;

async function gcWhatsAppOnce() {
  try {
    const r = await gcPendingWhatsAppOnboardings();
    if (r.apagadas > 0) logger.info({ ...r }, "[wa-onboard] instâncias pendentes vencidas apagadas");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[wa-onboard] falha no GC");
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: o worker grava "estou vivo" no Redis a cada 30s (expira em 90s).
// O /api/health lê essa chave — sem ela, o painel mostrava "saudável" com o
// motor de fluxos parado há dias.
// ---------------------------------------------------------------------------
const HEARTBEAT_KEY = "crmagro:worker:heartbeat";
const HEARTBEAT_MS = 30_000;

// RLS (camada 3): estado do pool do papel `crmagro_app` DESTE processo. O /api/health roda no site e só enxerga o
// pool do site, então o worker conta o dele pelo heartbeat (`rls` em cada chave por pid) e o motor do health
// vira `degraded` se algum worker acusar "problema". `undefined` = RLS desligado neste processo (o padrão).
// A sonda roda em intervalo próprio, NUNCA dentro do beat: pool cheio faria o heartbeat atrasar e expirar.
let rlsDoWorker: "ok" | "problema" | undefined;
const estadoDaSonda = (s: SondaBancoApp) => (!s.ativo ? undefined : s.ok ? ("ok" as const) : ("problema" as const));

async function beat() {
  try {
    const at = new Date().toISOString();
    const ttl = Math.ceil((HEARTBEAT_MS * 3) / 1000);
    await connection.set(HEARTBEAT_KEY, JSON.stringify({ at, pid: process.pid, primary: isPrimary }), "EX", ttl);
    // Uma chave POR PROCESSO (item 1.10): com N workers, todos gravavam a mesma
    // chave e um worker morto ficava escondido atrás do vivo.
    await connection.set(
      `${WORKER_HEARTBEAT_PREFIXO}${process.pid}`,
      JSON.stringify({ at, pid: process.pid, primary: isPrimary, ultimoJobEm, ...(rlsDoWorker ? { rls: rlsDoWorker } : {}) }),
      "EX",
      ttl,
    );
  } catch {
    // Redis fora: o health check já reporta o Redis por conta própria.
  }
}

// Desligamento limpo (pm2 manda SIGINT no stop/restart): fecha os workers para
// devolver os jobs em andamento à fila em vez de deixá-los "stalled".
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "[worker] encerrando");
  await Promise.allSettled([
    worker.close(),
    transcriptionWorker.close(),
    aiWorker.close(),
    inboundWorker.close(),
    emailEntradaWorker.close(),
    whatsappHistoryWorker.close(),
    captureWorker?.close(),
    socialWorker?.close(),
    agroWorker?.close(),
    limpezaWorker.close(),
    campaignWorker.close(),
    importWorker.close(),
    geoWorker.close(),
    agendaGoogleWorker.close(),
  ]);
  await connection.del(HEARTBEAT_KEY, `${WORKER_HEARTBEAT_PREFIXO}${process.pid}`).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  // RLS (camada 3): com DATABASE_URL_APP, confere o pool do papel crmagro_app e FALA ALTO se falhar (não
  // derruba o worker; o heartbeat leva o estado e o /api/health fica `degraded` pelo motor). Sem
  // DATABASE_URL_APP, não faz nada.
  void conectarBancoApp("worker").then((s) => {
    rlsDoWorker = estadoDaSonda(s);
    // O primeiro beat (abaixo) sai antes da sonda: um segundo, já com o estado, para o health ver na hora.
    if (rlsDoWorker) void beat();
  });
  if (env.DATABASE_URL_APP) {
    setInterval(() => void sondarBancoApp().then((s) => { rlsDoWorker = estadoDaSonda(s); }, () => {}), 60_000);
  }
  // Chromium que sobrou de um worker morto (item 3.2, INT-11).
  void matarChromiumOrfao();
  void beat();
  setInterval(() => void beat(), HEARTBEAT_MS);
  logger.info(
    { redis: redisTarget(env.REDIS_URL), primary: isPrimary },
    `[worker] boot — filas flow${isPrimary ? " + transcription + capture + social + poll e-mail/social (PRIMARY)" : " + transcription (secondary)"}`,
  );
  // Tarefas SINGLETON: só no processo primário (senão duplicam com N workers).
  if (isPrimary) {
    // Contatos com CPF antigo ganham a impressão do CPF (importação acha o mesmo CPF). Idempotente; some quando não há o que fazer.
    void preencherHashDoCpf()
      .then((n) => n > 0 && logger.info({ contatos: n }, "[worker] impressão do CPF preenchida"))
      .catch((err) => logger.warn({ err }, "[worker] não deu para preencher a impressão do CPF"));
    void historicosWhatsAppOnce();
    setInterval(() => void historicosWhatsAppOnce(), 60_000);
    void pollEmailOnce(); // primeira varredura no boot
    setInterval(() => void pollEmailOnce(), EMAIL_POLL_MS);
    // Sessões sociais: confere a cada 30 min se a rodada de 6 h venceu.
    void verifySocialOnce();
    setInterval(() => void verifySocialOnce(), 30 * 60_000);
    setInterval(() => void gcWhatsAppOnce(), WA_GC_MS);
    setInterval(() => void sweepOnce(), SWEEP_MS);
    setInterval(() => void retencaoOnce(), RETENCAO_MS);
    setInterval(() => void conexoesOnce(), WA_CONEXAO_MS);
    setInterval(() => void saudeOnce(), SAUDE_MS);
    setInterval(() => void reprocessarInboundOnce(), INBOUND_REPROCESSO_MS);
    setInterval(() => void varrerCampanhasOnce(), CAMPANHA_VARREDURA_MS);
    setInterval(() => void lembretesAgendaOnce(), AGENDA_LEMBRETE_MS);
  }
}

main().catch((err) => {
  logger.error({ err }, "[worker] erro no boot");
  process.exit(1);
});
