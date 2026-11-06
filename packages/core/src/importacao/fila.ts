import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";

/**
 * Fila `import` (produto §C): o commit da importação só grava o job e a
 * planilha no Storage; o worker processa em blocos, fora da requisição web.
 *
 * O worker registra o consumidor em `apps/worker/src/index.ts`. Uma importação
 * por time por vez (trava no Redis em `processarImportacao`); times diferentes
 * rodam em paralelo até `IMPORT_CONCURRENCY`.
 */
export const IMPORT_QUEUE = "import";

export type ImportacaoJob = { teamId: string; importJobId: string };

let conexao: Redis | null = null;
let fila: Queue | null = null;
function queue(): Queue {
  if (!fila) {
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    conexao.on("error", (err) => logger.warn({ err: err.message }, "[import] erro na conexão Redis"));
    fila = new Queue(IMPORT_QUEUE, { connection: conexao });
  }
  return fila;
}

/** Tentativas do job (a importação retoma do último bloco concluído). */
export const IMPORT_TENTATIVAS = 3;

/** Enfileira o processamento. `jobId` sem ":" (o BullMQ recusa). Lança se a fila não aceitar. */
export async function enfileirarImportacao(job: ImportacaoJob): Promise<void> {
  await queue().add("importar", job, {
    jobId: `import_${job.importJobId}`,
    attempts: IMPORT_TENTATIVAS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
  });
}
