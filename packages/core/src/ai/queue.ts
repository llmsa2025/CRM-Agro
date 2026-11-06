import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import type { AgentMessage, AgentToolCall } from "./schema";

/**
 * Fila da IA (Fase 2 da auditoria de escala): o loop de tool-use do assistente
 * (`runAgent`) roda no WORKER, não no processo web — antes segurava o event loop
 * do web por até 8×60s por conversa. O web só ENFILEIRA o job e faz streaming dos
 * tokens de volta pro navegador via Redis pub/sub (canal por `streamId`).
 *
 * Fluxo: web assina `ai:<streamId>` → enfileira o job → worker roda o agente e
 * PUBLICA cada trecho no canal → web repassa como SSE → no `done`/`error` fecha.
 */
export type AiChatJob = {
  streamId: string;
  teamId: string;
  /**
   * Quem pediu (RBAC, auditoria S7/S16): o worker roda o agente COM este papel.
   * Sem papel >= member o agente fica só com as tools de leitura. Opcional só
   * para jobs antigos na fila — ausente = só leitura (fail-closed).
   */
  userId?: string;
  role?: string;
  /** Telas de quem pediu (F2b): o worker roda o agente com elas. */
  modulos?: string[];
  /** "Ver tudo" por tela de quem pediu (F3): o agente lê com o mesmo escopo. */
  verTudoEm?: string[];
  /** "Editar" por tela de quem pediu: o agente altera com o mesmo escopo. Ausente (job antigo) = igual a `verTudoEm`. */
  editarTudoEm?: string[];
  /** OBSOLETO: o "ver tudo" tudo-ou-nada de antes (job que já estava na fila). */
  verTudo?: boolean;
  messages: AgentMessage[];
  provider?: "anthropic" | "glm";
  /**
   * Prazo absoluto da rodada (epoch ms), contado de quando a tela pediu — o
   * tempo parado na fila também conta. Assim o resultado chega antes do SSE
   * desistir (item 3.5). Ausente (job antigo) = agora + prazo padrão.
   */
  deadlineAt?: number;
};

/** Trecho publicado pelo worker e repassado ao navegador (mesmo shape do SSE). */
export type AiStreamChunk =
  | { type: "text"; text: string }
  | { type: "done"; reply: string; toolCalls: AgentToolCall[] }
  | { type: "error"; error: string };

const AI_QUEUE = "ai";
const channel = (streamId: string) => `crmagro:ai:${streamId}`;

let _conn: Redis | null = null;
let _queue: Queue | null = null;
let _pub: Redis | null = null;
function connection(): Redis {
  if (!_conn) _conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _conn;
}
function queue(): Queue {
  if (!_queue) _queue = new Queue(AI_QUEUE, { connection: connection() });
  return _queue;
}
function publisher(): Redis {
  if (!_pub) _pub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _pub;
}

/** Enfileira uma conversa de IA para o worker processar. */
export async function enqueueAiChat(job: AiChatJob): Promise<void> {
  await queue().add("ai", job, {
    attempts: 1, // efeito externo (API paga + tools de escrita) — não reexecutar
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  });
}

/**
 * Enfileira um job de IA de SEGUNDO PLANO (ex.: classificar a resposta de uma
 * campanha — produto §A.5) na mesma fila `ai`, com prioridade baixa: a fila
 * pega primeiro os jobs sem prioridade (a conversa do assistente, que tem
 * alguém esperando na tela) e só depois estes. `jobId` sem `:` (BullMQ).
 */
export async function enfileirarJobDeIa(
  dados: Record<string, unknown> & { kind: string },
  opts: { jobId: string; prioridade?: number; tentativas?: number },
): Promise<void> {
  await queue().add(dados.kind, dados, {
    jobId: opts.jobId,
    priority: opts.prioridade ?? 10,
    attempts: opts.tentativas ?? 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
  });
}

/** Publica um trecho no canal do stream (usado pelo worker). */
export async function publishAiChunk(streamId: string, chunk: AiStreamChunk): Promise<void> {
  await publisher().publish(channel(streamId), JSON.stringify(chunk));
}

/**
 * Assina o stream de uma conversa (usado pela rota web). Cria uma conexão
 * subscriber dedicada (ioredis em modo subscribe bloqueia a conexão). Chama
 * `onChunk` a cada trecho; devolve `close()` para encerrar (unsubscribe + quit).
 * IMPORTANTE: assinar ANTES de enfileirar, senão perde os primeiros trechos.
 */
export async function subscribeAiStream(
  streamId: string,
  onChunk: (chunk: AiStreamChunk) => void,
): Promise<() => Promise<void>> {
  const sub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const ch = channel(streamId);
  sub.on("message", (_ch, msg) => {
    try {
      onChunk(JSON.parse(msg) as AiStreamChunk);
    } catch {
      /* mensagem malformada — ignora */
    }
  });
  await sub.subscribe(ch);
  return async () => {
    try {
      await sub.unsubscribe(ch);
    } catch {
      /* noop */
    }
    sub.disconnect();
  };
}

export const AI_QUEUE_NAME = AI_QUEUE;
