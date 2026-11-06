import { env } from "@crmagro/config";
import { classificarErroDeRede, falhaHttp } from "../errors";

/**
 * Headers pra alcançar a Evolution API.
 *
 * - `apikey`: auth da própria Evolution (sempre presente).
 * - `CF-Access-Client-Id` / `CF-Access-Client-Secret`: service token do
 *   Cloudflare Access, injetado quando a Evolution está atrás de um Cloudflare
 *   Tunnel (ex.: chamadas do Vercel serverless). Em dev/VPS local o fetch vai
 *   direto ao localhost e essas vars são ausentes — o tunnel não é exigido.
 *
 * Centralizar aqui garante que TODA operação de saída (create/QR/verify/send)
 * atravessa o Access de forma idêntica; trocar o transporte é mexer só neste
 * arquivo + no env.
 */
export function evolutionHeaders(
  apiKey: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { apikey: apiKey, ...extra };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

/**
 * Descreve um erro incluindo o `cause` — o `fetch` do Node embrulha a causa
 * real (ECONNREFUSED, ENOTFOUND, cert, timeout) num `TypeError: fetch failed`
 * genérico. Sem desembrulhar, o erro não diz nada. Também anexa a URL-base
 * alvo, pra revelar na hora se ainda está apontando pro localhost.
 */
export function describeFetchError(e: unknown, apiUrl?: string): string {
  let msg: string;
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    msg = cause ? `${e.message}: ${cause instanceof Error ? cause.message : String(cause)}` : e.message;
  } else {
    msg = String(e);
  }
  return apiUrl ? `${msg} [alvo: ${apiUrl}]` : msg;
}

/**
 * Timeouts das chamadas à Evolution (INT-15). Sem eles, uma Evolution travada
 * segurava cada chamada até o padrão do undici (300 s) — bastavam 12 envios
 * pendurados para o motor inteiro parar.
 */
export const EVOLUTION_TIMEOUT_MS = {
  send: 15_000,
  presence: 12_000,
  history: 5_000,
  media: 30_000,
  /** Criar/conectar/apagar instância e configurar webhook (onboarding). */
  lifecycle: 20_000,
} as const;

/**
 * `fetch` para a Evolution com timeout e erro CLASSIFICADO: falha de rede vira
 * `ChannelSendFailed` (`not_sent` se a conexão nem abriu; `unknown` se caiu
 * depois). Resposta HTTP de erro vira `not_sent` (ver `exigirOk`).
 */
export async function evolutionFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operacao: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw classificarErroDeRede(e, operacao);
  }
}

/** Lança `ChannelSendFailed` (not_sent) se a resposta não for 2xx. */
export async function exigirOk(res: Response, operacao: string): Promise<void> {
  if (res.ok) return;
  const corpo = await res.text().catch(() => "");
  throw falhaHttp(res.status, corpo, operacao);
}
