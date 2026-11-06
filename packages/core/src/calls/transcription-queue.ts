import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";

/**
 * Fila de transcrição de chamadas — separada da fila "flow" para isolar
 * latência. Processo: webhook Voopi grava recordingUrl → enfileira
 * `scheduleTranscription` → worker baixa áudio, transcreve, gera resumo
 * via IA, e atualiza a Call.
 *
 * Mesmo padrão do `flows/queue.ts`: singleton lazy, IORedis, maxRetries null.
 */

export type TranscriptionJob = { callId: string };

const TRANSCRIPTION_QUEUE = "transcription";

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
    _queue = new Queue(TRANSCRIPTION_QUEUE, { connection: connection() });
  }
  return _queue;
}

/**
 * jobId da transcrição (dedup por chamada). SEM ":" — o BullMQ recusa id com
 * ":" que não tenha exatamente 3 partes ("Custom Id cannot contain :"). O
 * antigo `transcribe:<id>` fazia TODO agendamento lançar (engolido num
 * `.catch` com aviso): nenhuma ligação era transcrita.
 */
export function transcricaoJobId(callId: string): string {
  return `transcribe_${callId}`;
}

/** Enfileira transcrição de uma chamada (um job por chamada). */
export async function scheduleTranscription(callId: string): Promise<void> {
  await queue().add(
    "transcribe",
    { callId } satisfies TranscriptionJob,
    {
      jobId: transcricaoJobId(callId),
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  );
}
