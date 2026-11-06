import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";

/**
 * Fila `social` (item 1.8, MF-10): o DM de Instagram/LinkedIn sai da fila `flow`
 * (concorrência 12) e vai para uma fila própria, consumida SÓ pelo worker
 * primário, com trava por conta e um navegador por vez. Antes, 12 passos
 * sociais podiam abrir 12 Chromium ao mesmo tempo (~250 MB cada, no VPS da
 * produção) e várias sessões simultâneas com o MESMO cookie — sinal de ban.
 */

export const SOCIAL_QUEUE = "social";

export type EnvioSocialJob = {
  enrollmentId: string;
  nodeId: string;
  round: number;
  teamId: string;
  contactId: string;
  accountId: string;
  network: "instagram" | "linkedin";
  to: string;
  /** Texto já renderizado (e personalizado pela IA): o retry manda o MESMO texto. */
  text: string;
  /** Epoch ms: DM parado na fila além do limite é segurado, não enviado fora de contexto. */
  enfileiradoEm: number;
};

let _connection: Redis | null = null;
let _queue: Queue | null = null;

function queue(): Queue {
  if (!_queue) {
    _connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    _queue = new Queue(SOCIAL_QUEUE, { connection: _connection });
  }
  return _queue;
}

/** jobId determinístico do DM de um passo (BullMQ: sem ":" fora do formato de 3 partes). */
export function socialJobId(enrollmentId: string, nodeId: string, round: number): string {
  return `social_${enrollmentId}_${nodeId}_${round}`;
}

/**
 * Enfileira o DM. Mesmo passo/round = mesmo jobId: job vivo não é duplicado.
 * Job já TERMINADO com o mesmo id (o passo foi pausado e retomado, ou a
 * varredura o reagendou) sai antes — senão o `add` seria ignorado em silêncio
 * e o DM nunca mais sairia.
 */
export async function enfileirarEnvioSocial(job: EnvioSocialJob): Promise<void> {
  const jobId = socialJobId(job.enrollmentId, job.nodeId, job.round);
  const existente = await queue().getJob(jobId);
  if (existente) {
    const estado = await existente.getState();
    if (estado !== "completed" && estado !== "failed") return;
    await existente.remove();
  }
  await queue().add("dm", job, {
    jobId,
    // Erro de infraestrutura antes de marcar a fase (banco, Redis): repete.
    // O resultado do envio em si é tratado dentro do job (nunca relança).
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}

/** Estado do DM de um passo na fila `social` (null = não existe). */
export async function estadoDoEnvioSocial(enrollmentId: string, nodeId: string, round: number): Promise<string | null> {
  const job = await queue().getJob(socialJobId(enrollmentId, nodeId, round));
  if (!job) return null;
  return job.getState();
}
