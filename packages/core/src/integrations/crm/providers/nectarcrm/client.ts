/**
 * Cliente HTTP da API do Nectar (plano §2.1, §4.1 e §4.8). Ficha N1.
 *
 * Regra da pasta `providers/nectarcrm/`: só importa `zod` (só tipo aqui), tipos
 * e `node:crypto`. Nada de banco, de config do app nem do logger: o script
 * de homologação do N5 roda sem banco e sem `.env`.
 *
 * Por que NÃO usar o `safeFetch` (`http/safe-fetch.ts`): ele existe para URL
 * digitada por cliente (bloqueia IP interno e resolve DNS). Aqui o host é fixo,
 * e o teste precisa apontar o Nectar para `127.0.0.1:9`, que o `safeFetch`
 * recusaria. O transporte é injetável no mesmo estilo (`Transporte`).
 *
 * O token vai SÓ no cabeçalho `Access-Token`. A API também aceita
 * `?api_token=`, mas a URL acaba em log: essa forma é proibida.
 *
 * Sem retentativa aqui dentro. Quem decide tentar de novo é o motor (N9b).
 */
import type { z } from "zod";
import {
  CrmConflito,
  CrmCotaEsgotada,
  CrmCredencialInvalida,
  CrmDadoInvalido,
  CrmIndisponivel,
  CrmLimite,
  CrmNaoConfigurado,
  CrmNaoEncontrado,
  CrmRespostaInvalida,
  CrmResultadoIncerto,
  CrmSemPermissao,
  caminhoParaLog,
  type ErroCrm,
} from "../../errors";

export const NECTAR_BASE = "https://app.nectarcrm.com.br/crm/api/1";
export const TIMEOUT_JSON_MS = 20_000;
export const TIMEOUT_MULTIPART_MS = 120_000;

/**
 * Base usada AGORA: a do chamador, senão `NECTAR_API_BASE` (só teste), senão a
 * real. Lida a cada pedido (não no carregamento do módulo), para o teste poder
 * mudar a variável. Ler `process.env` aqui é permitido: é global, não é import.
 */
export function baseDoNectar(base?: string): string {
  const escolhida = base?.trim() || baseDoAmbiente() || NECTAR_BASE;
  return escolhida.replace(/\/+$/, "");
}

/**
 * `NECTAR_API_BASE` é só de teste. Em PRODUÇÃO só vale se apontar para a própria máquina (loopback):
 * qualquer outro endereço seria o destino do `Access-Token` do cliente, e uma variável posta por engano
 * (ou por quem alcança o .env) mandaria o token para fora. Fora de produção vale sempre.
 */
function baseDoAmbiente(): string | undefined {
  const valor = process.env.NECTAR_API_BASE?.trim();
  if (!valor) return undefined;
  if (process.env.NODE_ENV === "production" && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(valor)) return undefined;
  return valor;
}

export type PedidoNectar = {
  metodo: "GET" | "POST" | "PUT";
  url: string;
  cabecalhos: Record<string, string>;
  corpo?: string | FormData;
  timeoutMs: number;
};
export type RespostaNectar = { status: number; cabecalho: (nome: string) => string | null; texto: string };
export type TransporteNectar = (p: PedidoNectar) => Promise<RespostaNectar>;

/** Transporte padrão: o `fetch` global (lido na hora) com `AbortSignal.timeout`. */
export const transportePadrao: TransporteNectar = async (p) => {
  const res = await globalThis.fetch(p.url, {
    method: p.metodo,
    headers: p.cabecalhos,
    body: p.corpo,
    signal: AbortSignal.timeout(p.timeoutMs),
    // Sem seguir redirecionamento: o `fetch` do Node não tira cabeçalho custom
    // (`Access-Token`) num salto para outro host. Um 3xx vira erro.
    redirect: "manual",
  });
  return { status: res.status, cabecalho: (nome) => res.headers.get(nome), texto: await res.text() };
};

/** Pedaço de caminho codificado (RFC 3986). O `encodeURIComponent` sozinho NÃO codifica `(` `)` (plano §2.4). */
export function segmento(valor: string): string {
  return encodeURIComponent(valor).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Cota do plano esgotada (status 429 ou 403 com texto de cota). O formato
 * exato vem do suporte do Nectar (pergunta 18 do plano §3.1): ajustar no N20.
 */
export function pareceCotaEsgotada(status: number, texto: string): boolean {
  return (status === 429 || status === 403) && /cota|quota|limite de requisi/i.test(texto);
}

/** `Retry-After` em segundos ou como data HTTP, convertido para ms. Sem cabeçalho (ou ilegível): `undefined`. */
export function retryAfterEmMs(valor: string | null, agora: number = Date.now()): number | undefined {
  if (!valor) return undefined;
  const v = valor.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const data = Date.parse(v);
  return Number.isNaN(data) ? undefined : Math.max(0, data - agora);
}

/**
 * Classifica uma resposta que NÃO é 2xx. Pura. A mensagem leva só o método, o
 * caminho para log, o status e o `x-request-id`: nunca o token, o corpo nem a query.
 */
export function erroDaResposta(
  metodo: PedidoNectar["metodo"],
  caminho: string,
  status: number,
  texto: string,
  requestId: string | null,
  retryAfter: string | null,
): ErroCrm {
  const rid = requestId ?? undefined;
  const msg = (nome: string) =>
    `${nome}: ${metodo} ${caminhoParaLog(caminho)} → HTTP ${status}${requestId ? ` (x-request-id ${requestId})` : ""}`;
  // A cota vem ANTES do 429/403 comum: pausa a conexão em vez de tentar de novo.
  if (pareceCotaEsgotada(status, texto)) return new CrmCotaEsgotada(msg("CrmCotaEsgotada"), status, rid);
  if (status === 401) return new CrmCredencialInvalida(msg("CrmCredencialInvalida"), status, rid);
  if (status === 403) return new CrmSemPermissao(msg("CrmSemPermissao"), status, rid);
  if (status === 404) return new CrmNaoEncontrado(msg("CrmNaoEncontrado"), status, rid);
  if (status === 409) return new CrmConflito(msg("CrmConflito"), status, rid);
  if (status === 429) return new CrmLimite(msg("CrmLimite"), status, rid, retryAfterEmMs(retryAfter));
  if (status >= 400 && status < 500) return new CrmDadoInvalido(msg("CrmDadoInvalido"), status, rid);
  // 5xx (e qualquer outra coisa fora do esperado): leitura pode repetir; escrita fica incerta.
  return metodo === "GET"
    ? new CrmIndisponivel(msg("CrmIndisponivel"), status, rid)
    : new CrmResultadoIncerto(msg("CrmResultadoIncerto"), status, rid);
}

/** Erro de rede ou tempo esgotado (o transporte lançou): sem status, sem corpo. */
export function erroDeTransporte(metodo: PedidoNectar["metodo"], caminho: string, e: unknown): ErroCrm {
  const tempo = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  const motivo = tempo ? "tempo esgotado" : "falha de rede";
  const base = `${metodo} ${caminhoParaLog(caminho)} → sem resposta (${motivo})`;
  return metodo === "GET"
    ? new CrmIndisponivel(`CrmIndisponivel: ${base}`)
    : new CrmResultadoIncerto(`CrmResultadoIncerto: ${base}`);
}

export type QueryNectar = Record<string, string | number | (string | number)[]>;

export type ClienteNectar = {
  get<T>(caminho: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, query?: QueryNectar): Promise<T>;
  post<T>(caminho: string, corpo: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T>;
  put<T>(caminho: string, corpo: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T>;
  /** Multipart (N5): o N19 o usa para anexar arquivo à nota. */
  postMultipart<T>(caminho: string, form: FormData, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T>;
};

/** Query por `URLSearchParams`; valor em lista repete a chave (`attribute=id&attribute=nome`). */
function montarQuery(query?: QueryNectar): string {
  const qs = new URLSearchParams();
  for (const [chave, valor] of Object.entries(query ?? {})) {
    if (Array.isArray(valor)) for (const item of valor) qs.append(chave, String(item));
    else qs.append(chave, String(valor));
  }
  return qs.toString();
}

export function criarClienteNectar(opts: { token: string; transporte?: TransporteNectar; base?: string }): ClienteNectar {
  if (!opts.token) throw new CrmNaoConfigurado();
  const transporte = opts.transporte ?? transportePadrao;

  async function chamar<T>(
    metodo: PedidoNectar["metodo"],
    caminho: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    extra: { query?: QueryNectar; corpo?: unknown; multipart?: FormData },
  ): Promise<T> {
    const qs = montarQuery(extra.query);
    const cabecalhos: Record<string, string> = { "Access-Token": opts.token, Accept: "application/json" };
    let corpo: string | FormData | undefined;
    if (extra.multipart) {
      corpo = extra.multipart; // sem Content-Type manual: o fetch põe o boundary
    } else if (extra.corpo !== undefined) {
      cabecalhos["Content-Type"] = "application/json";
      corpo = JSON.stringify(extra.corpo);
    }
    const pedido: PedidoNectar = {
      metodo,
      // A base é lida a CADA pedido (baseDoNectar), não no carregamento do módulo.
      url: `${baseDoNectar(opts.base)}${caminho}${qs ? `?${qs}` : ""}`,
      cabecalhos,
      corpo,
      timeoutMs: extra.multipart ? TIMEOUT_MULTIPART_MS : TIMEOUT_JSON_MS,
    };

    let resposta: RespostaNectar;
    try {
      resposta = await transporte(pedido);
    } catch (e) {
      throw erroDeTransporte(metodo, caminho, e);
    }
    const requestId = resposta.cabecalho("x-request-id");
    if (resposta.status < 200 || resposta.status >= 300) {
      throw erroDaResposta(metodo, caminho, resposta.status, resposta.texto, requestId, resposta.cabecalho("retry-after"));
    }

    const rid = requestId ? ` (x-request-id ${requestId})` : "";
    const onde = `${metodo} ${caminhoParaLog(caminho)} → HTTP ${resposta.status}${rid}`;
    let dados: unknown = null; // 2xx com corpo vazio vira null
    if (resposta.texto.trim() !== "") {
      try {
        dados = JSON.parse(resposta.texto);
      } catch {
        throw new CrmRespostaInvalida(`CrmRespostaInvalida: ${onde}: a resposta não é JSON`, resposta.status, requestId ?? undefined);
      }
    }
    const lido = schema.safeParse(dados);
    if (!lido.success) {
      // Só o caminho do primeiro erro do zod: nunca os valores.
      const campo = lido.error.issues[0]?.path.join(".") || "(raiz)";
      throw new CrmRespostaInvalida(`CrmRespostaInvalida: ${onde}: formato inesperado em ${campo}`, resposta.status, requestId ?? undefined);
    }
    return lido.data;
  }

  return {
    get: (caminho, schema, query) => chamar("GET", caminho, schema, { query }),
    post: (caminho, corpo, schema) => chamar("POST", caminho, schema, { corpo }),
    put: (caminho, corpo, schema) => chamar("PUT", caminho, schema, { corpo }),
    // Multipart: `POST` com o `FormData` no corpo, SEM Content-Type manual (o `fetch` põe o boundary),
    // timeout de 120 s e a mesma classificação de erro do JSON (5xx ou tempo esgotado: resultado incerto).
    postMultipart: (caminho, form, schema) => chamar("POST", caminho, schema, { multipart: form }),
  };
}
