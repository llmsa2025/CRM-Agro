import {
  fetchViaCnpja,
  fetchViaBrasilApi,
  fetchViaOpenCnpj,
  normalizeCnpj,
  CnpjInvalid,
  CnpjNotFound,
  CnpjaLimite,
  OpenCnpjLimite,
  type CnpjResult,
} from "@crmagro/captation";
import { logger } from "../logger/index";
import { redisCache, redisEstado } from "../shared/redis-cache";
import type { DraftInput } from "./service";

/**
 * Consulta de CNPJ COMPARTILHADA (item 3.2, INT-13) — a única porta para
 * captação, enriquecimento e a tool `lookup_cnpj` da IA.
 *
 * Antes cada um chamava a fonte direto: o limite de 5/min do CNPJá é POR IP da
 * VPS, dividido entre todos os times; numa lista de 100 CNPJs, 5 saíam ricos e
 * 95 levavam 429 e caíam numa rajada na BrasilAPI (que também barra); e o mesmo
 * CNPJ era consultado de novo pelo enriquecimento e pela IA.
 *
 * - **Cache** `cnpj:<dígitos>`, 30 dias, COMPARTILHADO entre times: é dado
 *   público da Receita (nada do time entra na chave nem no valor). Exceção
 *   consciente à regra "cache por time".
 * - **Fichas do CNPJá** `cnpja:tokens`: janela deslizante global de 5 por 60 s
 *   (o limite real do CNPJá). Sem ficha, vai direto à BrasilAPI — sem bater no
 *   429. Um 429 mesmo assim (outro app no IP) esvazia as fichas por 60 s.
 * - Sem ficha (ou se o CNPJá falhar) vem a OpenCNPJ (gratuita, traz e-mail, telefone e
 *   sócios, mas não as IEs) e, por último, a BrasilAPI (só Receita, geralmente sem e-mail).
 * - Resultado que não é do CNPJá é `parcial`: quando houver ficha, a próxima
 *   consulta do mesmo CNPJ tenta o CNPJá e melhora o cache.
 */

export const CHAVE_FICHAS_CNPJA = "cnpja:tokens";
export const CNPJA_POR_MINUTO = Number(process.env.CNPJA_POR_MINUTO ?? 5);
const JANELA_MS = 60_000;
export const CNPJ_CACHE_TTL_S = 30 * 24 * 60 * 60;
const NAO_ENCONTRADO_TTL_S = 24 * 60 * 60;

export const chaveCacheCnpj = (digitos: string) => `cnpj:${digitos}`;

/** Depois de um 429 da OpenCNPJ, ninguém a chama por este tempo (a API é gratuita e não publica limite). */
export const CHAVE_PAUSA_OPENCNPJ = "opencnpj:pausa";
export const PAUSA_OPENCNPJ_S = 60;

async function opencnpjEmPausa(): Promise<boolean> {
  try {
    return (await redisEstado().exists(CHAVE_PAUSA_OPENCNPJ)) === 1;
  } catch {
    return false; // Redis fora: tenta (o pior caso é um 429 a mais)
  }
}

async function pausarOpencnpj(): Promise<void> {
  try {
    await redisEstado().set(CHAVE_PAUSA_OPENCNPJ, "1", "EX", PAUSA_OPENCNPJ_S);
  } catch {
    /* sem Redis não há como pausar para todos; o próximo 429 só repete o aviso */
  }
}

// Janela deslizante atômica: tira os carimbos com mais de 60 s; se sobram menos
// que o limite, carimba e devolve 1 (tem ficha); senão 0. ARGV[4] = esvaziar
// (enche a janela: ninguém usa o CNPJá pelos próximos 60 s).
const FICHA_LUA = `
local agora = tonumber(ARGV[1])
local janela = tonumber(ARGV[2])
local limite = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', agora - janela)
if ARGV[4] == '1' then
  for i = 1, limite do redis.call('ZADD', KEYS[1], agora, 'cheio-' .. agora .. '-' .. i) end
  redis.call('PEXPIRE', KEYS[1], janela)
  return 0
end
if redis.call('ZCARD', KEYS[1]) < limite then
  redis.call('ZADD', KEYS[1], agora, agora .. '-' .. ARGV[5])
  redis.call('PEXPIRE', KEYS[1], janela)
  return 1
end
return 0
`;

/** Pega uma ficha do CNPJá. Redis fora → sem ficha (não arrisca 429 sem coordenação). */
export async function tomarFichaCnpja(): Promise<boolean> {
  if (!(CNPJA_POR_MINUTO > 0)) return false;
  try {
    const r = await redisEstado().eval(
      FICHA_LUA,
      1,
      CHAVE_FICHAS_CNPJA,
      String(Date.now()),
      String(JANELA_MS),
      String(CNPJA_POR_MINUTO),
      "0",
      Math.random().toString(36).slice(2),
    );
    return Number(r) === 1;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cnpj] fichas do CNPJá indisponíveis — indo pela BrasilAPI");
    return false;
  }
}

async function esvaziarFichasCnpja(): Promise<void> {
  try {
    await redisEstado().eval(FICHA_LUA, 1, CHAVE_FICHAS_CNPJA, String(Date.now()), String(JANELA_MS), String(CNPJA_POR_MINUTO), "1", "x");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cnpj] não esvaziei as fichas do CNPJá");
  }
}

type Cacheado = { r: CnpjResult } | { naoEncontrado: true };

async function lerCache(digitos: string): Promise<Cacheado | null> {
  try {
    const raw = await redisCache().get(chaveCacheCnpj(digitos));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<{ r: CnpjResult; naoEncontrado: boolean }>;
    if (v.naoEncontrado) return { naoEncontrado: true };
    // Cache de antes dos campos novos (ou corrompido) = miss.
    if (v.r && typeof v.r.cnpj === "string" && (v.r.fonte === "cnpja" || v.r.fonte === "opencnpj" || v.r.fonte === "brasilapi")) return { r: v.r };
    return null;
  } catch {
    return null; // cache é fail-fast: Redis fora = consulta na fonte
  }
}

async function gravarCache(digitos: string, v: Cacheado): Promise<void> {
  try {
    const ttl = "naoEncontrado" in v ? NAO_ENCONTRADO_TTL_S : CNPJ_CACHE_TTL_S;
    await redisCache().set(chaveCacheCnpj(digitos), JSON.stringify(v), "EX", ttl);
  } catch (err) {
    logger.debug({ cnpj: digitos, err: err instanceof Error ? err.message : String(err) }, "[cnpj] não gravei o cache");
  }
}

export type OrigemConsultaCnpj = "cache" | "cnpja" | "opencnpj" | "brasilapi";

/** Igual a `consultarCnpj`, dizendo de onde veio (o lote só pausa entre idas à rede). */
export async function consultarCnpjDetalhado(
  input: string,
): Promise<{ resultado: CnpjResult; origem: OrigemConsultaCnpj }> {
  const digitos = normalizeCnpj(input);
  if (!digitos) throw new CnpjInvalid(input);

  const cache = await lerCache(digitos);
  if (cache && "naoEncontrado" in cache) throw new CnpjNotFound(digitos);
  const emCache = cache?.r ?? null;
  if (emCache && !emCache.parcial) return { resultado: emCache, origem: "cache" };

  // Parcial em cache só vale nova ida se houver ficha do CNPJá (para enriquecer).
  const ficha = await tomarFichaCnpja();
  // Cache que veio só da BrasilAPI (sem e-mail) ainda pode melhorar pela OpenCNPJ; os demais ficam como estão.
  if (emCache && !ficha && emCache.fonte !== "brasilapi") return { resultado: emCache, origem: "cache" };

  if (ficha) {
    try {
      const r = await fetchViaCnpja(digitos);
      await gravarCache(digitos, { r });
      return { resultado: r, origem: "cnpja" };
    } catch (e) {
      if (e instanceof CnpjNotFound) {
        await gravarCache(digitos, { naoEncontrado: true });
        throw e;
      }
      if (e instanceof CnpjaLimite) await esvaziarFichasCnpja();
      logger.warn({ cnpj: digitos, err: e instanceof Error ? e.message : String(e) }, "[cnpj] CNPJá falhou — indo pela BrasilAPI");
      if (emCache && emCache.fonte !== "brasilapi") return { resultado: emCache, origem: "cache" };
    }
  }

  // OpenCNPJ: falha de qualquer tipo (inclusive "não achei") só passa a vez para a BrasilAPI. Um 429 pausa a
  // OpenCNPJ por um minuto para todos os times.
  if (!(await opencnpjEmPausa())) {
    try {
      const r = await fetchViaOpenCnpj(digitos);
      await gravarCache(digitos, { r });
      return { resultado: r, origem: "opencnpj" };
    } catch (e) {
      if (e instanceof OpenCnpjLimite) await pausarOpencnpj();
      logger.debug({ cnpj: digitos, err: e instanceof Error ? e.message : String(e) }, "[cnpj] OpenCNPJ não respondeu — indo pela BrasilAPI");
    }
  }
  if (emCache) return { resultado: emCache, origem: "cache" }; // BrasilAPI já estava no cache e a OpenCNPJ falhou

  try {
    const r = await fetchViaBrasilApi(digitos);
    await gravarCache(digitos, { r });
    return { resultado: r, origem: "brasilapi" };
  } catch (e) {
    if (e instanceof CnpjNotFound) await gravarCache(digitos, { naoEncontrado: true });
    throw e;
  }
}

/**
 * Consulta um CNPJ pelo cache compartilhado + fichas do CNPJá + BrasilAPI.
 * Lança `CnpjInvalid`, `CnpjNotFound` ou `CnpjLookupFailed`.
 */
export async function consultarCnpj(input: string): Promise<CnpjResult> {
  return (await consultarCnpjDetalhado(input)).resultado;
}

/** Rascunho a partir do resultado da consulta — marca `fonte` e `parcial` (INT-13). */
export function draftDoCnpj(r: CnpjResult): DraftInput {
  return {
    nome: r.nome,
    empresa: r.razaoSocial ?? r.nome,
    cnpj: r.cnpj,
    telefone: r.telefone,
    email: r.email,
    cidade: r.cidade,
    uf: r.uf,
    cnae: r.cnaeDescricao,
    // Minimização: o rascunho guarda o nome e a qualificação dos sócios, não o CPF mascarado deles.
    extra: { ...r, socios: r.socios.map((s) => ({ nome: s.nome, qualificacao: s.qualificacao })) },
  };
}

export function motivoFalhaCnpj(e: unknown): string {
  if (e instanceof CnpjInvalid) return "CNPJ inválido";
  if (e instanceof CnpjNotFound) return "não encontrado";
  return e instanceof Error ? e.message : String(e);
}
