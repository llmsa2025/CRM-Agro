import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";

/**
 * Rate limiting por chave (ex.: por teamId) via Redis — janela fixa (INCR +
 * EXPIRE). Protege recursos caros/limitados (loop de IA + API paga, importações)
 * contra rajada/abuso, especialmente com muitos times simultâneos.
 *
 * REDIS FORA: o limite continua valendo EM MEMÓRIA, por processo (mesmas janelas e
 * tetos). Não nega por falha de infra (negar o login porque o Redis caiu seria
 * pior que o risco), mas também não libera tudo: antes, o cliente enfileirava o
 * comando e ESPERAVA a reconexão sem prazo, então com o Redis fora a requisição
 * de login ficava pendurada e o limite de força bruta não existia. Agora o
 * cliente falha na hora (`enableOfflineQueue: false`) e cai no contador local. Com N
 * processos, o teto efetivo é até N× o de cima; ainda corta a rajada.
 *
 * Exceção: `{ falhaFecha: true }` — porta PÚBLICA que gasta um recurso comum
 * (ex.: o cadastro com senha manda e-mail pela cota da plataforma). Aí Redis
 * fora = NEGA (`semRedis: true`, para a tela dizer "indisponível" em vez de
 * "muitas tentativas"). Usa o cliente `redisEstado` (falha depois de 2
 * tentativas), porque o deste arquivo espera a reconexão sem prazo.
 */

let client: Redis | null = null;
function getClient(): Redis {
  if (!client) {
    // Falha NA HORA com o Redis fora (sem fila offline): quem chama cai no contador em memória.
    client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 });
    client.on("error", (err) => {
      logger.error({ err: err.message }, "[rate-limit] erro na conexão Redis");
    });
  }
  return client;
}

/** No 1º uso do processo o cliente ainda está conectando: espera um instante em vez de errar. */
const ESPERA_CONEXAO_MS = 1500;
/** Depois de uma falha, o Redis é dado como fora por este tempo (tudo vai direto para a memória). */
const DISJUNTOR_MS = 5000;
let semRedisAte = 0;

/** O cliente, já conectado. Cliente recém-criado (1º uso) espera ficar pronto; sem fila offline, nunca fica pendurado. */
async function clientePronto(): Promise<Redis> {
  const r = getClient();
  if (r.status === "connecting" || r.status === "connect") {
    await new Promise<void>((ok, falha) => {
      const limpar = () => {
        clearTimeout(timer);
        r.off("ready", pronto);
        r.off("error", erro);
      };
      const pronto = () => (limpar(), ok());
      const erro = (e: Error) => (limpar(), falha(e));
      const timer = setTimeout(() => erro(new Error("Redis ainda conectando")), ESPERA_CONEXAO_MS);
      r.once("ready", pronto);
      r.once("error", erro);
    });
  }
  return r;
}

/** Redis tentou e falhou agora: nos próximos segundos nem tenta (evita esperar a cada requisição). */
function marcarSemRedis(): void {
  semRedisAte = Date.now() + DISJUNTOR_MS;
}

/** Só para teste: reabre o disjuntor. */
export function reabrirRedisDoLimite(): void {
  semRedisAte = 0;
}

/** `semRedis`: negado só porque o Redis estava fora (com `falhaFecha`). */
export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterMs: number; semRedis?: true };

/** `falhaFecha`: Redis fora = NEGA (porta pública; ver o topo do arquivo). */
export type OpcoesDoLimite = { falhaFecha?: boolean };

// ---------------------------------------------------------------------------
// Plano B sem Redis: janela fixa em memória (por processo)
// ---------------------------------------------------------------------------
const memoria = new Map<string, { n: number; fim: number }>();
/** Teto de janelas guardadas: com um ataque de muitas chaves, recomeça em vez de crescer sem limite. */
const MAX_JANELAS_EM_MEMORIA = 20_000;
let ultimoAvisoSemRedis = 0;

function avisarSemRedis(key: string, e: unknown): void {
  const agora = Date.now();
  if (agora - ultimoAvisoSemRedis < 60_000) return;
  ultimoAvisoSemRedis = agora;
  logger.warn(
    { err: e instanceof Error ? e.message : String(e), key: key.split(":").slice(0, 2).join(":") },
    "[rate-limit] Redis indisponível: limitando em memória (por processo)",
  );
}

function chaveEmMemoria(key: string, windowMs: number): { k: string; fim: number } {
  const bucket = Math.floor(Date.now() / windowMs);
  return { k: `${key}:${bucket}`, fim: (bucket + 1) * windowMs };
}

function resultadoDaMemoria(n: number, max: number, windowMs: number, consumindo: boolean): RateLimitResult {
  const allowed = consumindo ? n <= max : n < max;
  return { allowed, remaining: Math.max(0, max - n), retryAfterMs: allowed ? 0 : windowMs - (Date.now() % windowMs) };
}

function consumirNaMemoria(key: string, max: number, windowMs: number): RateLimitResult {
  const agora = Date.now();
  if (memoria.size >= MAX_JANELAS_EM_MEMORIA) {
    for (const [k, v] of memoria) if (v.fim <= agora) memoria.delete(k);
    if (memoria.size >= MAX_JANELAS_EM_MEMORIA) memoria.clear();
  }
  const { k, fim } = chaveEmMemoria(key, windowMs);
  const atual = memoria.get(k);
  const n = (atual?.n ?? 0) + 1;
  memoria.set(k, { n, fim });
  return resultadoDaMemoria(n, max, windowMs, true);
}

function consultarNaMemoria(key: string, max: number, windowMs: number): RateLimitResult {
  return resultadoDaMemoria(memoria.get(chaveEmMemoria(key, windowMs).k)?.n ?? 0, max, windowMs, false);
}

/** Só para teste: esquece todas as janelas em memória. */
export function limparLimitesEmMemoria(): void {
  memoria.clear();
}

function negadoSemRedis(key: string, windowMs: number, e: unknown): RateLimitResult {
  logger.warn({ err: e instanceof Error ? e.message : String(e), key }, "[rate-limit] Redis indisponível — fail-closed (negando)");
  return { allowed: false, remaining: 0, retryAfterMs: windowMs, semRedis: true };
}

/**
 * Consome 1 do orçamento de `key` na janela de `windowMs`. Permite até `max` por
 * janela. Retorna `allowed` e, quando negado, `retryAfterMs` até a próxima janela.
 */
export async function rateLimit(key: string, max: number, windowMs: number, opts: OpcoesDoLimite = {}): Promise<RateLimitResult> {
  if (!opts.falhaFecha && Date.now() < semRedisAte) return consumirNaMemoria(key, max, windowMs);
  try {
    const redis = opts.falhaFecha ? redisEstado() : await clientePronto();
    const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
    const bucket = Math.floor(Date.now() / windowMs);
    const k = `rl:${key}:${bucket}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSec);
    const allowed = n <= max;
    return {
      allowed,
      remaining: Math.max(0, max - n),
      retryAfterMs: allowed ? 0 : windowMs - (Date.now() % windowMs),
    };
  } catch (e) {
    if (opts.falhaFecha) return negadoSemRedis(key, windowMs, e);
    marcarSemRedis();
    avisarSemRedis(key, e);
    return consumirNaMemoria(key, max, windowMs);
  }
}

/**
 * Consulta o orçamento de `key` SEM consumir (mesma janela do `rateLimit`).
 * Para limitar só FALHAS: consulta antes, consome (`rateLimit`) quando falhar.
 * Redis fora → conta em memória (como o `rateLimit`), ou NEGADO com `falhaFecha`.
 */
export async function peekRateLimit(key: string, max: number, windowMs: number, opts: OpcoesDoLimite = {}): Promise<RateLimitResult> {
  if (!opts.falhaFecha && Date.now() < semRedisAte) return consultarNaMemoria(key, max, windowMs);
  try {
    const bucket = Math.floor(Date.now() / windowMs);
    const n = Number((await (opts.falhaFecha ? redisEstado() : await clientePronto()).get(`rl:${key}:${bucket}`)) ?? 0);
    const allowed = n < max;
    return {
      allowed,
      remaining: Math.max(0, max - n),
      retryAfterMs: allowed ? 0 : windowMs - (Date.now() % windowMs),
    };
  } catch (e) {
    if (opts.falhaFecha) return negadoSemRedis(key, windowMs, e);
    marcarSemRedis();
    avisarSemRedis(key, e);
    return consultarNaMemoria(key, max, windowMs);
  }
}

/**
 * Zera o orçamento de `key` na janela atual (ex.: login certo zera as falhas).
 * Zera também o contador em memória (o do plano B).
 */
export async function resetRateLimit(key: string, windowMs: number): Promise<void> {
  memoria.delete(chaveEmMemoria(key, windowMs).k);
  if (Date.now() < semRedisAte) return;
  try {
    const bucket = Math.floor(Date.now() / windowMs);
    await (await clientePronto()).del(`rl:${key}:${bucket}`);
  } catch {
    marcarSemRedis();
    /* sem Redis: o contador em memória já foi zerado acima */
  }
}

/**
 * Chave de limite para um IP. IPv6: só o prefixo /64 — um provedor entrega um
 * /64 inteiro a cada cliente, e o limite pelo endereço completo era trocado a
 * cada pedido (18 quintilhões de "IPs" por pessoa). IPv4 (e IPv4 mapeado em
 * IPv6, `::ffff:1.2.3.4`) segue inteiro. Texto que não é IP volta como veio.
 */
export function chaveDoIp(ip: string): string {
  const bruto = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!bruto.includes(":")) return bruto;
  const mapeado = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bruto);
  if (mapeado) return mapeado[1]!;
  const [cabeca = "", cauda] = bruto.split("::");
  const antes = cabeca ? cabeca.split(":") : [];
  const depois = cauda === undefined ? [] : cauda ? cauda.split(":") : [];
  // Um IPv4 no fim (`64:ff9b::1.2.3.4`) ocupa DOIS grupos de 16 bits.
  const tamanho = (xs: string[]) => xs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const grupos =
    cauda === undefined ? antes : [...antes, ...Array<string>(Math.max(0, 8 - tamanho(antes) - tamanho(depois))).fill("0"), ...depois];
  if (grupos.length < 4 || grupos.slice(0, 4).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return bruto;
  return `${grupos
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
