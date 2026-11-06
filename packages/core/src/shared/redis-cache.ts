import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";

/**
 * Clientes Redis de uso geral (fora das filas BullMQ).
 *
 * - `redisCache()`: CACHE curto (ex.: estado da sessão). Sem fila offline e com
 *   1 tentativa — se o Redis cair, a chamada falha na hora e quem usa cai no
 *   banco. Nunca trava o login. (A 1ª chamada do processo, antes de conectar,
 *   também falha e cai no banco — é cache, tudo bem.)
 * - `redisEstado()`: ESTADO que importa (ex.: dono de uma instância WhatsApp
 *   pendente). Espera a conexão (fila offline) e falha depois de 2 tentativas —
 *   quem usa trata a falha como "negado" (fail-closed).
 */
let cache: Redis | null = null;
let estado: Redis | null = null;

export function redisCache(): Redis {
  if (!cache) {
    cache = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    });
    cache.on("error", (err) => {
      logger.warn({ err: err.message }, "[redis-cache] erro na conexão");
    });
  }
  return cache;
}

export function redisEstado(): Redis {
  if (!estado) {
    estado = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 3000 });
    estado.on("error", (err) => {
      logger.warn({ err: err.message }, "[redis-estado] erro na conexão");
    });
  }
  return estado;
}
