import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";

/**
 * Producer da fila de execução de fluxos. Singleton lazy — BullMQ `Queue` é só
 * um handle sobre o Redis; criar múltiplos é caro e desnecessário.
 *
 * `scheduleStep` é chamado por:
 *  - `triggers.enrollByTrigger` (1º passo, ao inscrever o contato)
 *  - `service.enroll` (inscrição manual / teste)
 *  - o handler do worker (próximo passo, possivelmente com `delayMs` p/ `wait`)
 *
 * O jobId determinístico `${enrollmentId}:${nodeId}:${round}` faz a dedup do
 * BullMQ: um `add` com jobId existente é ignorado — protege contra
 * double-scheduling (retry duplicado, trigger re-emitido, race). A unicidade
 * real por round vive no DB (`FlowStepExecution.@@unique`).
 */

export type StepJob = {
  enrollmentId: string;
  nodeId: string;
  round: number;
  /**
   * Quando o passo DEVERIA ter rodado (epoch ms). Só vem em reagendamento
   * (varredura de órfãs / retry pelo ponteiro): sem isto, uma órfã de dias
   * atrás pareceria "no horário" e mandaria "bom dia" fora de contexto — com
   * isto, a trava de passo vencido do worker a segura para revisão.
   */
  plannedAt?: number;
};

const FLOW_QUEUE = "flow";

let _connection: Redis | null = null;
let _queue: Queue | null = null;

function connection(): Redis {
  if (!_connection) {
    _connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return _connection;
}

function queue(): Queue {
  if (!_queue) {
    _queue = new Queue(FLOW_QUEUE, { connection: connection() });
  }
  return _queue;
}

/** jobId determinístico de um passo (3 partes com ":" — o BullMQ aceita esse formato). */
export function flowJobId(enrollmentId: string, nodeId: string, round: number): string {
  return `${enrollmentId}:${nodeId}:${round}`;
}

/**
 * Estado do job de um passo na fila (item 0.9 — varredura de órfãs): `null` se
 * o job não existe mais. Estados vivos: waiting, delayed, active, prioritized,
 * waiting-children.
 */
export async function getStepJobState(jobId: string): Promise<string | null> {
  const job = await queue().getJob(jobId);
  if (!job) return null;
  return job.getState();
}

/**
 * Acorda um passo que está esperando (item 1.1): o job de timeout já existe
 * atrasado → `promote()` (roda agora, mesmo jobId, sem duplicar). Sem job (ou
 * job já concluído) → agenda com atraso zero.
 */
export async function acordarPasso(enrollmentId: string, nodeId: string, round: number): Promise<void> {
  const jobId = flowJobId(enrollmentId, nodeId, round);
  const job = await queue().getJob(jobId);
  if (job) {
    const estado = await job.getState();
    if (estado === "delayed") {
      await job.promote();
      return;
    }
    if (estado === "waiting" || estado === "active" || estado === "prioritized") return; // já vai rodar
    await job.remove(); // concluído/falho: sai para o add abaixo valer
  }
  await scheduleStep(enrollmentId, nodeId, round);
}

/** Remove o job de um passo (para reagendar um que terminou sem avançar). */
export async function removeStepJob(jobId: string): Promise<void> {
  const job = await queue().getJob(jobId);
  if (job) await job.remove();
}

/** Enfileira a execução de um passo. `delayMs` agenda um job atrasado (nó wait). */
export async function scheduleStep(
  enrollmentId: string,
  nodeId: string,
  round: number,
  delayMs?: number,
  plannedAt?: number,
): Promise<void> {
  const data: StepJob = { enrollmentId, nodeId, round, ...(plannedAt ? { plannedAt } : {}) };
  await queue().add("step", data, {
    jobId: flowJobId(enrollmentId, nodeId, round),
    delay: delayMs,
    attempts: 5,
    // Jitter de 50%: centenas de passos que falham juntos (Evolution fora, banco piscando) não voltam todos no mesmo segundo.
    backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}
