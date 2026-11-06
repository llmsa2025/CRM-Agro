import { z } from "zod";
import { env } from "@crmagro/config";
import { getCurrentTeamId } from "@crmagro/db";
import { redisCache } from "../shared/redis-cache";

/**
 * Cliente mínimo do Supabase Storage (REST, sem dependência @supabase/*).
 * Bucket PRIVADO `conversas-midia`: nada é público — a leitura sempre passa por
 * URL assinada de curta duração. Server-side only (usa a service_role key).
 *
 * Fail-soft: sem SUPABASE_URL/KEY configurados, `storageEnabled()` é false e as
 * funções de leitura devolvem null — a UI cai pro texto e nada quebra.
 */

const BUCKET = "conversas-midia";

function base(): { url: string; key: string } | null {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export function storageEnabled(): boolean {
  return base() !== null;
}

function authHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

/**
 * Teto de tempo do upload (INT-15): 30 s + 1 s por MB. Antes não havia — um
 * Storage lento segurava a action do inbox (web) ou o job do inbound (worker)
 * até o padrão do undici (300 s).
 */
export function uploadTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil(bytes / (1024 * 1024)) * 1000;
}

/** Sobe bytes pro bucket no `path` dado (upsert). Lança em falha. */
export async function uploadMedia(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const b = base();
  if (!b) throw new Error("StorageNaoConfigurado");
  const res = await fetch(`${b.url}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: "POST",
    headers: authHeaders(b.key, { "Content-Type": contentType, "x-upsert": "true" }),
    // Buffer/Uint8Array são corpos válidos no fetch do Node (undici).
    body: bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(uploadTimeoutMs(bytes.byteLength)),
  });
  if (!res.ok) {
    throw new Error(`Storage upload falhou (${res.status}): ${await res.text()}`);
  }
}

/** Validade padrão da URL assinada (s). */
export const SIGNED_URL_EXPIRES_S = 3600;
/**
 * A URL assinada fica 50 min no Redis (item 2.2, DP-02): a thread e o detalhe do
 * contato eram re-renderizados a cada mensagem nova e cada mídia virava 1 POST
 * ao Storage. Guardada por no máximo `expiresIn − 10 min`, então quem recebe do
 * cache ainda tem ≥ 10 min de validade.
 */
const CACHE_URL_MAX_S = 50 * 60;
const MARGEM_URL_S = 10 * 60;
/** Teto de tempo de uma chamada de assinatura (antes era sem timeout). */
const ASSINAR_TIMEOUT_MS = 10_000;

const chaveUrl = (teamId: string, path: string) => `midia:url:${teamId}:${path}`;

/** Resposta do lote: `[{ path, signedURL, error }]` (URL relativa a /storage/v1). */
const loteSchema = z.array(
  z.object({
    path: z.string().nullish(),
    signedURL: z.string().nullish(),
    error: z.string().nullish(),
  }),
);

/** 1 POST por objeto (o modo antigo; hoje só fallback e caso de 1 path). */
async function assinarUm(b: { url: string; key: string }, path: string, expiresIn: number): Promise<string | null> {
  try {
    const res = await fetch(`${b.url}/storage/v1/object/sign/${BUCKET}/${encodeURI(path)}`, {
      method: "POST",
      headers: authHeaders(b.key, { "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn }),
      signal: AbortSignal.timeout(ASSINAR_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { signedURL?: string };
    return data.signedURL ? `${b.url}/storage/v1${data.signedURL}` : null;
  } catch {
    return null;
  }
}

/**
 * Assina VÁRIOS objetos num único POST (`/object/sign/{bucket}` com `paths[]`).
 * Devolve `null` se a API de lote falhar (quem chama cai no modo unitário).
 */
async function assinarLote(
  b: { url: string; key: string },
  paths: string[],
  expiresIn: number,
): Promise<Map<string, string | null> | null> {
  try {
    const res = await fetch(`${b.url}/storage/v1/object/sign/${BUCKET}`, {
      method: "POST",
      headers: authHeaders(b.key, { "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn, paths }),
      signal: AbortSignal.timeout(ASSINAR_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const lido = loteSchema.safeParse(await res.json());
    if (!lido.success) return null;
    const out = new Map<string, string | null>();
    for (const item of lido.data) {
      if (!item.path) continue;
      out.set(item.path, item.signedURL && !item.error ? `${b.url}/storage/v1${item.signedURL}` : null);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * URLs assinadas (curta duração) de VÁRIOS objetos privados, com cache Redis
 * por time (`midia:url:<teamId>:<path>`) e UM request ao Storage para o que
 * faltar. Se a API de lote falhar, assina um a um (fallback). Path sem URL
 * (Storage desligado, objeto inexistente) → `null` no mapa: quem chama trata
 * como "sem mídia" e mostra o texto/placeholder.
 */
export async function signedMediaUrls(
  paths: readonly string[],
  expiresIn = SIGNED_URL_EXPIRES_S,
): Promise<Map<string, string | null>> {
  const teamId = getCurrentTeamId();
  const unicos = [...new Set(paths.filter((p) => p))];
  const out = new Map<string, string | null>();
  const b = base();
  if (!b || unicos.length === 0) {
    for (const p of unicos) out.set(p, null);
    return out;
  }

  const ttlCache = Math.min(CACHE_URL_MAX_S, expiresIn - MARGEM_URL_S);
  const usaCache = Boolean(teamId) && ttlCache > 0;
  let faltam = unicos;
  if (usaCache) {
    try {
      const hits = await redisCache().mget(...unicos.map((p) => chaveUrl(teamId!, p)));
      faltam = [];
      unicos.forEach((p, i) => {
        const hit = hits[i];
        if (hit) out.set(p, hit);
        else faltam.push(p);
      });
    } catch {
      faltam = unicos; // sem Redis: assina tudo
    }
  }
  if (faltam.length === 0) return out;

  const lote = faltam.length > 1 ? await assinarLote(b, faltam, expiresIn) : null;
  const assinadas = lote ?? new Map(await Promise.all(faltam.map(async (p) => [p, await assinarUm(b, p, expiresIn)] as const)));
  const novas: [string, string][] = [];
  for (const p of faltam) {
    const url = assinadas.get(p) ?? null;
    out.set(p, url);
    if (url) novas.push([p, url]);
  }
  if (usaCache && novas.length) {
    try {
      const multi = redisCache().multi();
      for (const [p, url] of novas) multi.set(chaveUrl(teamId!, p), url, "EX", ttlCache);
      await multi.exec();
    } catch {
      /* cache é opcional */
    }
  }
  return out;
}

/**
 * URL assinada de UM objeto privado (mesmo cache do lote). Devolve null se o
 * Storage não está configurado ou a assinatura falha. Para listas, use
 * `signedMediaUrls` (um request só).
 */
export async function signedMediaUrl(path: string, expiresIn = SIGNED_URL_EXPIRES_S): Promise<string | null> {
  return (await signedMediaUrls([path], expiresIn)).get(path) ?? null;
}

/** Storage sem SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — recurso que depende dele não roda. */
export class StorageNaoConfigurado extends Error {
  constructor() {
    super("StorageNaoConfigurado: configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
    this.name = "StorageNaoConfigurado";
  }
}

/** Download de um objeto privado falhou (o job que precisa dele tenta de novo). */
export class StorageDownloadFalhou extends Error {
  constructor(status: number) {
    super(`Storage: download falhou (HTTP ${status})`);
    this.name = "StorageDownloadFalhou";
  }
}

/**
 * Baixa um objeto PRIVADO do bucket (com a service key, sem URL assinada). Uso
 * interno do servidor — ex.: o worker lê a planilha da importação.
 */
export async function baixarArquivo(path: string): Promise<Uint8Array> {
  const b = base();
  if (!b) throw new StorageNaoConfigurado();
  const res = await fetch(`${b.url}/storage/v1/object/authenticated/${BUCKET}/${encodeURI(path)}`, {
    headers: authHeaders(b.key),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new StorageDownloadFalhou(res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** Remove um objeto (best-effort; usado em rollback de envio). */
export async function deleteMedia(path: string): Promise<void> {
  const b = base();
  if (!b) return;
  await fetch(`${b.url}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: "DELETE",
    headers: authHeaders(b.key),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

/** O Storage recusou a remoção em lote (o job de limpeza tenta de novo). */
export class StorageRemocaoFalhou extends Error {
  constructor(status: number) {
    super(`Storage: remoção em lote falhou (HTTP ${status})`);
    this.name = "StorageRemocaoFalhou";
  }
}

/**
 * Remove vários objetos numa chamada (`DELETE /object/{bucket}` com
 * `prefixes`). Diferente do `deleteMedia`, LANÇA em falha — é usado pelo job
 * de limpeza da exclusão de contato (LGPD), que precisa de retry. Objeto que
 * já não existe não é erro. Sem Storage configurado → nada a apagar.
 */
export async function removerMidias(paths: string[]): Promise<void> {
  const b = base();
  if (!b || paths.length === 0) return;
  const res = await fetch(`${b.url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: authHeaders(b.key, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new StorageRemocaoFalhou(res.status);
}
