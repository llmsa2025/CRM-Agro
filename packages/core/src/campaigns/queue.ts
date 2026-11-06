import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";

/**
 * Fila `campaign` (produto §A.2/A.3). Dois tipos de job:
 * - `lista`: monta e classifica a lista (`montarLista`) — minutos numa lista de
 *   milhares (checagem de WhatsApp, histórico, contatos novos);
 * - `tick`: um passo de envio da campanha (worker, item A.3).
 *
 * Mesmo padrão das outras filas: singleton lazy; jobId SEM ":" (o BullMQ recusa).
 */

export const CAMPAIGN_QUEUE = "campaign";

export type CampaignJob =
  | { kind: "lista"; teamId: string; campaignId: string; versao: string }
  | { kind: "tick"; teamId: string; campaignId: string; token: string; seq: number };

let conexao: Redis | null = null;
let fila: Queue<CampaignJob> | null = null;

export function getCampaignQueue(): Queue<CampaignJob> {
  if (!fila) {
    // Produtor (web e worker): com o Redis fora, falha rápido em vez de
    // segurar a requisição sem prazo (mesmo padrão da fila de importação).
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    fila = new Queue<CampaignJob>(CAMPAIGN_QUEUE, { connection: conexao });
  }
  return fila;
}

export function campaignJobId(job: CampaignJob): string {
  return job.kind === "lista" ? `lista_${job.campaignId}_${job.versao}` : `tick_${job.campaignId}_${job.token}_${job.seq}`;
}

/** Enfileira a montagem da lista (dedup pela versão: reentrega não monta 2×). */
export async function agendarMontagemDaLista(input: { teamId: string; campaignId: string; versao: string }): Promise<void> {
  const job: CampaignJob = { kind: "lista", ...input };
  await getCampaignQueue().add("lista", job, {
    jobId: campaignJobId(job),
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  });
}

/**
 * Agenda o próximo tick da corrente `token` (seq = posição na corrente). O
 * jobId leva token + seq: o mesmo tick reentregue ou refeito (retry) não cria
 * uma segunda corrente.
 */
export async function agendarTick(input: {
  teamId: string;
  campaignId: string;
  token: string;
  seq: number;
  delayMs: number;
}): Promise<void> {
  const { delayMs, ...resto } = input;
  const job: CampaignJob = { kind: "tick", ...resto };
  await getCampaignQueue().add("tick", job, {
    jobId: campaignJobId(job),
    delay: Math.max(0, Math.round(delayMs)),
    // Tick ocupado (outro do mesmo time ainda segura a trava) tenta de novo.
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  });
}
