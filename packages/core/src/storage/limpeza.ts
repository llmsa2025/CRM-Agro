import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { basePrisma } from "@crmagro/db";
import { logger } from "../logger/index";
import { removerMidias } from "./service";

/**
 * Limpeza das mídias no Storage quando um contato é excluído (item 3.7, S15 —
 * LGPD art. 18). O cascade do banco apaga mensagens e atividades, mas os
 * arquivos (`<conversationId>/…`, `deals/<dealId>/…`) ficavam no bucket para
 * sempre. A exclusão enfileira os caminhos AQUI; o worker apaga com retry.
 *
 * O job é enfileirado ANTES de apagar as linhas e roda com atraso: se a
 * exclusão falhar no meio, o arquivo ainda referenciado por alguma mensagem ou
 * atividade do time é MANTIDO (conferência no próprio job). Nunca apaga mídia
 * que ainda está em uso.
 *
 * O worker registra o consumidor em `apps/worker/src/index.ts`:
 *   new Worker(STORAGE_LIMPEZA_QUEUE, (job) => processarLimpezaDeMidia(job.data), { connection, concurrency: 2 })
 */
export const STORAGE_LIMPEZA_QUEUE = "storage-limpeza";

export type LimpezaDeMidiaJob = { teamId: string; paths: string[] };

/** Caminhos por job (e por chamada ao Storage). */
const LOTE = 100;
/** Atraso: dá tempo de a exclusão terminar antes da conferência de uso. */
const ATRASO_MS = 2 * 60_000;

let conexao: Redis | null = null;
let fila: Queue | null = null;
function queue(): Queue {
  if (!fila) {
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    conexao.on("error", (err) => logger.warn({ err: err.message }, "[storage-limpeza] erro na conexão Redis"));
    fila = new Queue(STORAGE_LIMPEZA_QUEUE, { connection: conexao });
  }
  return fila;
}

/** Enfileira a remoção (lotes de 100). Lança se a fila não aceitar. */
export async function enfileirarLimpezaDeMidia(teamId: string, paths: string[]): Promise<number> {
  const unicos = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const job: LimpezaDeMidiaJob = { teamId, paths: unicos.slice(i, i + LOTE) };
    await queue().add("midias", job, {
      delay: ATRASO_MS,
      attempts: 8,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    });
  }
  return unicos.length;
}

/**
 * Consumidor: apaga do Storage os caminhos que NENHUMA mensagem ou atividade do
 * time referencia mais. Falha do Storage → lança (o BullMQ retenta).
 */
export async function processarLimpezaDeMidia(job: LimpezaDeMidiaJob): Promise<{ apagados: number; mantidos: number }> {
  const { teamId, paths } = job;
  if (paths.length === 0) return { apagados: 0, mantidos: 0 };
  // Job cross-contato de um time só: teamId explícito em cada consulta.
  const [msgs, acts] = await Promise.all([
    basePrisma.message.findMany({ where: { teamId, mediaPath: { in: paths } }, select: { mediaPath: true } }),
    basePrisma.activity.findMany({ where: { teamId, mediaPath: { in: paths } }, select: { mediaPath: true } }),
  ]);
  const emUso = new Set([...msgs, ...acts].map((r) => r.mediaPath));
  const apagar = paths.filter((p) => !emUso.has(p));
  await removerMidias(apagar);
  logger.info({ teamId, apagados: apagar.length, mantidos: paths.length - apagar.length }, "[lgpd] mídias removidas do Storage");
  return { apagados: apagar.length, mantidos: paths.length - apagar.length };
}
