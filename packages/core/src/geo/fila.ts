import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";
import { backfillGeocode } from "./geocode";

/**
 * Fila `geo` (produto §B.2) — a geocodificação roda SÓ no worker, nunca numa
 * requisição web. Um job repetido (`backfill`, a cada 30 s) geocodifica os
 * contatos pendentes: novos, com endereço mudado (o trigger do banco zera o
 * `geoHash`) ou com falha passageira. A vez do Nominatim é global no Redis,
 * então o Worker pode rodar em qualquer processo.
 */
export const GEO_QUEUE = "geo";
export type JobGeo = { tipo: "backfill" };
export const GEO_BACKFILL_MS = Number(process.env.GEO_BACKFILL_MS ?? 30_000);

let _conn: Redis | null = null;
let _queue: Queue<JobGeo> | null = null;
function queue(): Queue<JobGeo> {
  if (!_conn) _conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  if (!_queue) _queue = new Queue<JobGeo>(GEO_QUEUE, { connection: _conn });
  return _queue;
}

/** Agenda (idempotente) o backfill repetido. Chamado no boot do worker. */
export async function agendarBackfillGeo(): Promise<void> {
  try {
    await queue().upsertJobScheduler(
      "geo_backfill",
      { every: GEO_BACKFILL_MS },
      { name: "backfill", data: { tipo: "backfill" }, opts: { removeOnComplete: true, removeOnFail: { count: 50 } } },
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[geo] não agendei o backfill");
  }
}

/** Processa um job da fila `geo` (o worker só registra isto). */
export async function processarJobGeo(job: JobGeo): Promise<void> {
  if (job.tipo === "backfill") {
    const r = await backfillGeocode();
    if (r.processados > 0 || r.erros > 0) logger.info({ ...r }, "[geo] backfill");
  }
}
