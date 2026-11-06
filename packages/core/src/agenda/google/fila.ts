import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../../logger/index";

/**
 * Fila `agenda-google` (worker). Dois tipos de job:
 * - `sync`: sincroniza a agenda de UMA conexão (Google → CRM Agro). Vem do aviso
 *   por push, da rodada de manutenção (polling de reserva) e do "Sincronizar
 *   agora". O id do job junta rajadas de avisos em janelas de 10 s; a trava
 *   por conexão (Redis) impede duas sincronizações da mesma agenda juntas.
 * - `manutencao`: repetido a cada minuto (job scheduler idempotente): acha as
 *   agendas com sincronização vencida e reenvia ao Google o que ficou pendente.
 */
export const AGENDA_GOOGLE_QUEUE = "agenda-google";
export type JobAgendaGoogle = { tipo: "sync"; connectionId: string } | { tipo: "manutencao" };
export const AGENDA_GOOGLE_MANUTENCAO_MS = Number(process.env.AGENDA_GOOGLE_MANUTENCAO_MS ?? 60_000);

let _conn: Redis | null = null;
let _queue: Queue<JobAgendaGoogle> | null = null;
function fila(): Queue<JobAgendaGoogle> {
  if (!_conn) _conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  if (!_queue) _queue = new Queue<JobAgendaGoogle>(AGENDA_GOOGLE_QUEUE, { connection: _conn });
  return _queue;
}

/** Pede uma sincronização da conexão (idempotente dentro da janela de 10 s). */
export async function enfileirarSyncGoogle(connectionId: string, opts: { atrasoMs?: number } = {}): Promise<void> {
  const quando = Date.now() + (opts.atrasoMs ?? 0);
  await fila().add(
    "sync",
    { tipo: "sync", connectionId },
    {
      jobId: `sync-${connectionId}-${Math.floor(quando / 10_000)}`,
      ...(opts.atrasoMs ? { delay: opts.atrasoMs } : {}),
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    },
  );
}

/** Agenda (idempotente) a manutenção repetida. Chamado no boot do worker. */
export async function agendarManutencaoAgendaGoogle(): Promise<void> {
  try {
    await fila().upsertJobScheduler(
      "agenda_google_manutencao",
      { every: AGENDA_GOOGLE_MANUTENCAO_MS },
      { name: "manutencao", data: { tipo: "manutencao" }, opts: { removeOnComplete: true, removeOnFail: { count: 50 } } },
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[agenda-google] não agendei a manutenção");
  }
}
