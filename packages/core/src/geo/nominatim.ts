import { z } from "zod";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { GeocodificadorIndisponivel, type Geocodificador, type ResultadoProvedor } from "./geocodificador";
import { ufDe } from "./endereco";

/**
 * Nominatim (OpenStreetMap) — implementação do `Geocodificador` (produto §B.2).
 *
 * Política de uso do Nominatim público (https://operations.osmfoundation.org/policies/nominatim/),
 * cumprida aqui:
 * - no máximo **1 requisição/s para a PLATAFORMA inteira**: vez global no
 *   Redis (`geo:nominatim`), não por time nem por processo. Redis fora = não
 *   chama (sem coordenação não há como garantir o limite);
 * - `User-Agent` identificando o CRM Agro, com contato (`GEO_CONTATO`). Sem
 *   contato, o público NÃO é chamado (o contato fica no centroide da cidade e
 *   é tentado de novo depois);
 * - só no worker, em fila (backfill), nunca numa requisição web;
 * - cache agressivo (`GeoCache`, global) — o mesmo endereço não volta aqui.
 * `NOMINATIM_URL` troca pela instância própria quando houver. Sempre
 * `countrycodes=br`.
 *
 * `fetch` direto (não o `safeFetch`): a URL vem da configuração do operador,
 * não do usuário, e uma instância própria costuma estar em rede privada — que o
 * `safeFetch` barra de propósito.
 */

export const NOMINATIM_PUBLICO = "https://nominatim.openstreetmap.org";
export const CHAVE_VEZ_NOMINATIM = "geo:nominatim";
/** 1 req/s: intervalo mínimo entre DUAS requisições quaisquer da plataforma. */
export const INTERVALO_NOMINATIM_MS = 1000;
/** Espera máxima pela vez; acima disso a fila está cheia e o contato fica para depois. */
const ESPERA_MAXIMA_MS = 20_000;
/**
 * Teto diário de chamadas ao Nominatim (a política desencoraja geocodificação
 * em massa contínua). Estourou: o contato fica no centroide da cidade e é
 * tentado de novo depois. Ajustável por env; instância própria pode subir.
 */
export const NOMINATIM_MAX_DIA = Number(process.env.GEO_NOMINATIM_MAX_DIA ?? 2000);
const TIMEOUT_MS = 10_000;

// Reserva atômica do próximo horário livre: devolve quantos ms esperar (0 =
// agora) e empurra o próximo livre para `horário + intervalo`. Duas reservas
// nunca caem a menos de `intervalo` uma da outra, em qualquer processo.
const VEZ_LUA = `
local agora = tonumber(ARGV[1])
local intervalo = tonumber(ARGV[2])
local proximo = tonumber(redis.call('GET', KEYS[1]) or '0')
local horario = math.max(agora, proximo)
redis.call('SET', KEYS[1], tostring(horario + intervalo), 'PX', (horario - agora) + intervalo * 10)
return horario - agora
`;

/** Reserva a próxima vez de chamar o Nominatim. Devolve os ms de espera. */
export async function reservarVezNominatim(agora = Date.now(), intervaloMs = INTERVALO_NOMINATIM_MS): Promise<number> {
  const espera = await redisEstado().eval(VEZ_LUA, 1, CHAVE_VEZ_NOMINATIM, String(agora), String(intervaloMs));
  return Number(espera) || 0;
}

/** Conta a chamada do dia (UTC); true = ainda dentro do teto. */
export async function contarChamadaDoDia(agora = new Date(), teto = NOMINATIM_MAX_DIA): Promise<boolean> {
  const chave = `${CHAVE_VEZ_NOMINATIM}:dia:${agora.toISOString().slice(0, 10)}`;
  // INCR + EXPIRE NX na mesma transação: a chave nunca fica sem TTL.
  const r = await redisEstado().multi().incr(chave).expire(chave, 2 * 24 * 60 * 60, "NX").exec();
  const n = Number(r?.[0]?.[1] ?? Infinity);
  return n <= teto;
}

/** Espera a vez (dorme o necessário). Sem Redis, teto do dia ou fila cheia → indisponível. */
async function aguardarVez(): Promise<void> {
  let espera: number;
  try {
    if (!(await contarChamadaDoDia())) throw new GeocodificadorIndisponivel(`teto diário do Nominatim (${NOMINATIM_MAX_DIA})`);
    espera = await reservarVezNominatim();
  } catch (err) {
    if (err instanceof GeocodificadorIndisponivel) throw err;
    throw new GeocodificadorIndisponivel(`sem a vez global no Redis (${err instanceof Error ? err.message : String(err)})`);
  }
  if (espera > ESPERA_MAXIMA_MS) throw new GeocodificadorIndisponivel(`fila do Nominatim cheia (${Math.round(espera / 1000)} s)`);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
}

// Resposta do /reverse?format=jsonv2&addressdetails=1 — só o que usamos.
const reversoSchema = z
  .object({
    address: z
      .object({
        city: z.string().optional(),
        town: z.string().optional(),
        village: z.string().optional(),
        municipality: z.string().optional(),
        state: z.string().optional(),
        "ISO3166-2-lvl4": z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Resposta do /search?format=jsonv2 — zod na borda; só o que usamos.
const respostaSchema = z.array(
  z
    .object({
      lat: z.coerce.number(),
      lon: z.coerce.number(),
      place_rank: z.coerce.number().optional(),
    })
    .passthrough(),
);

/**
 * `place_rank` do Nominatim → precisão. 26+ = rua/número; 13–25 = bairro,
 * distrito, cidade; abaixo disso (estado, país) não serve para o mapa.
 */
function precisaoDoRank(rank: number | undefined): "endereco" | "cidade" | null {
  if (rank === undefined) return "cidade";
  if (rank >= 26) return "endereco";
  if (rank >= 13) return "cidade";
  return null;
}

export class NominatimGeocodificador implements Geocodificador {
  readonly nome = "nominatim";
  private readonly url: string;
  private readonly contato: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly vez: () => Promise<void>;

  constructor(
    opts: { url?: string; contato?: string | null; fetchImpl?: typeof fetch; aguardarVez?: () => Promise<void> } = {},
  ) {
    this.url = (opts.url ?? env.NOMINATIM_URL ?? NOMINATIM_PUBLICO).replace(/\/+$/, "");
    this.contato = opts.contato !== undefined ? opts.contato : env.GEO_CONTATO?.trim() || null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.vez = opts.aguardarVez ?? aguardarVez;
  }

  private get publico(): boolean {
    return this.url === NOMINATIM_PUBLICO;
  }

  async buscar(consulta: string): Promise<ResultadoProvedor | null> {
    if (this.publico && !this.contato) {
      throw new GeocodificadorIndisponivel("GEO_CONTATO não configurado: a política do Nominatim público exige contato no User-Agent");
    }
    await this.vez();
    const params = new URLSearchParams({ q: consulta, format: "jsonv2", countrycodes: "br", limit: "1", addressdetails: "0" });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/search?${params.toString()}`, {
        headers: {
          "user-agent": `CRM Agro/1.0 (${this.contato ?? "instancia-propria"})`,
          "accept-language": "pt-BR",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const tempo = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new GeocodificadorIndisponivel(tempo ? `sem resposta em ${TIMEOUT_MS / 1000}s` : `erro de rede: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Consulta que o Nominatim recusa por ser inválida: é "não achou" (vai para
    // o cache), não falha passageira — senão voltaria de hora em hora, para sempre.
    if (res.status === 400 || res.status === 414) return null;
    if (!res.ok) {
      // 429/403 = a política foi violada ou o IP foi barrado: registrar alto.
      if (res.status === 429 || res.status === 403) logger.error({ status: res.status }, "[geo] Nominatim recusou — conferir a política de uso");
      throw new GeocodificadorIndisponivel(`HTTP ${res.status}`);
    }
    const corpo = respostaSchema.safeParse(await res.json().catch(() => null));
    if (!corpo.success) throw new GeocodificadorIndisponivel("resposta fora do formato");
    const r = corpo.data[0];
    if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return null;
    const precisao = precisaoDoRank(r.place_rank);
    if (!precisao) return null; // só achou o estado/país: não serve
    return { latitude: r.lat, longitude: r.lon, precisao };
  }

  /** Cidade/UF do ponto (`/reverse`). Ver `reversoNominatim`. */
  async reverso(p: { latitude: number; longitude: number }): Promise<{ cidade: string | null; estado: string | null } | null> {
    if (this.publico && !this.contato) {
      throw new GeocodificadorIndisponivel("GEO_CONTATO não configurado: a política do Nominatim público exige contato no User-Agent");
    }
    await this.vez();
    const params = new URLSearchParams({ lat: String(p.latitude), lon: String(p.longitude), format: "jsonv2", zoom: "10", addressdetails: "1" });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/reverse?${params.toString()}`, {
        headers: {
          "user-agent": `CRM Agro/1.0 (${this.contato ?? "instancia-propria"})`,
          "accept-language": "pt-BR",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const tempo = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new GeocodificadorIndisponivel(tempo ? `sem resposta em ${TIMEOUT_MS / 1000}s` : `erro de rede: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) logger.error({ status: res.status }, "[geo] Nominatim recusou — conferir a política de uso");
      throw new GeocodificadorIndisponivel(`HTTP ${res.status}`);
    }
    const corpo = reversoSchema.safeParse(await res.json().catch(() => null));
    if (!corpo.success || !corpo.data.address) return null;
    const a = corpo.data.address;
    const cidade = a.city ?? a.town ?? a.village ?? a.municipality ?? null;
    const iso = a["ISO3166-2-lvl4"];
    const estado = (iso && iso.startsWith("BR-") ? iso.slice(3) : null) ?? ufDe(a.state ?? null);
    return { cidade, estado };
  }
}

/** O provedor em uso. Trocar de provedor é trocar aqui. */
export function geocodificadorPadrao(): Geocodificador {
  return new NominatimGeocodificador();
}
