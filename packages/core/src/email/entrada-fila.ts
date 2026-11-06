import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";
import type { EmailEncaminhadoJob } from "./entrada-encaminhada";

/**
 * Fila `email-entrada`: o e-mail que o Worker do Cloudflare entregou à rota fica
 * aqui até o worker processar (`processarEmailEncaminhado`). Mesmo molde do
 * `inbound-queue`: a rota só GRAVA na fila (Redis, milissegundos) e responde 200;
 * se nem isso der, responde 503 e o Cloudflare guarda o e-mail e tenta de novo.
 */

export const EMAIL_ENTRADA_QUEUE = "email-entrada";

/** Tempo máximo para gravar na fila antes de responder 503. */
const ENQUEUE_TIMEOUT_MS = 3000;

let conexao: Redis | null = null;
let fila: Queue | null = null;

function queue(): Queue {
  if (!fila) {
    // Produtor: 1 tentativa por comando. Com o Redis fora, falha rápido e a rota
    // devolve 503 (o Cloudflare reenvia) em vez de segurar a requisição.
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: ENQUEUE_TIMEOUT_MS });
    conexao.on("error", (err) => logger.warn({ err: err.message }, "[email-entrada] erro na conexão Redis"));
    fila = new Queue(EMAIL_ENTRADA_QUEUE, { connection: conexao });
  }
  return fila;
}

/**
 * `ee_` + os 32 primeiros hex do sha256 do encaminhamento e do conteúdo (sem `:`,
 * que o BullMQ recusa). O mesmo e-mail reentregue pelo Cloudflare cai no mesmo job. O id
 * do encaminhamento entra no hash: o mesmo e-mail encaminhado por duas caixas (de
 * times diferentes, inclusive) são dois jobs, e um não pode descartar o outro.
 */
export function jobIdDoEmailEncaminhado(encaminhamentoId: string, rawB64: string): string {
  return `ee_${createHash("sha256").update(`${encaminhamentoId}:${rawB64}`).digest("hex").slice(0, 32)}`;
}

/** Grava o job na fila. Lança se não conseguir em 3 s (quem chama responde 503). */
export async function enfileirarEmailEncaminhado(job: EmailEncaminhadoJob): Promise<void> {
  // O e-mail cru de quem não é contato não pode ficar guardado no Redis: nem o que deu certo
  // nem o que esgotou as tentativas (`removeOnComplete` e `removeOnFail` em `true`, nunca
  // `{ count }` nem `{ age }`). O motivo da falha fica só no log do `failed` do worker.
  const add = queue().add("email", job, {
    jobId: jobIdDoEmailEncaminhado(job.encaminhamentoId, job.rawB64),
    attempts: 10,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("fila email-entrada indisponível (timeout)")), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([add, limite]);
  } finally {
    clearTimeout(timer);
  }
}
