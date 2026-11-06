import { logger } from "../logger/index";
import { redisCache } from "./redis-cache";

/**
 * Cache curto no Redis com invalidação por GERAÇÃO (mesmo padrão do Painel,
 * item 2.3). A chave SEMPRE carrega o time (`<área>:<teamId>`) — quem chama
 * monta a chave com o `teamId` do contexto, nunca do cliente.
 *
 * Por que geração e não só `DEL`: um cálculo que começou ANTES de uma escrita e
 * terminou DEPOIS da invalidação gravaria o valor velho por todo o TTL. Com a
 * geração, o valor guardado carrega a geração com que nasceu; invalidar sobe o
 * contador e a próxima leitura vê a diferença e recalcula.
 *
 * Fail-open: sem Redis, calcula direto e não guarda (é cache).
 */

/** A geração só precisa viver mais que o valor guardado; 1 dia sobra. */
const GERACAO_TTL_S = 86_400;

type Guardado<T> = { ger: string; valor: T };

const chaveGeracao = (chave: string) => `${chave}:ger`;

/**
 * `grupo`: a chave cuja geração vale para esta (padrão: a própria). Várias
 * chaves do mesmo grupo (ex.: o badge de cada pessoa do time, F3) caem juntas
 * com um só `invalidarCache(grupo)`.
 */
export async function lerOuCalcular<T>(chave: string, ttlS: number, calcular: () => Promise<T>, grupo = chave): Promise<T> {
  let ger = "0";
  let comRedis = true;
  try {
    const [g, bruto] = await redisCache().mget(chaveGeracao(grupo), chave);
    ger = g ?? "0";
    if (bruto) {
      const guardado = JSON.parse(bruto) as Guardado<T>;
      if (guardado.ger === ger) return guardado.valor;
    }
  } catch {
    comRedis = false; // sem Redis: calcula direto, sem guardar
  }
  const valor = await calcular();
  if (comRedis) {
    try {
      await redisCache().set(chave, JSON.stringify({ ger, valor } satisfies Guardado<T>), "EX", ttlS);
    } catch {
      /* cache é opcional */
    }
  }
  return valor;
}

/** Invalida a chave (sobe a geração). Best-effort: nunca lança. */
export async function invalidarCache(chave: string): Promise<void> {
  try {
    await redisCache().multi().incr(chaveGeracao(chave)).expire(chaveGeracao(chave), GERACAO_TTL_S).exec();
  } catch (err) {
    logger.debug(
      { chave, err: err instanceof Error ? err.message : String(err) },
      "[cache] não invalidado (Redis indisponível) — expira sozinho",
    );
  }
}
