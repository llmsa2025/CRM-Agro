import { basePrisma, db, runAsSystem } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { distanciaKm, geoHashDe, normalizarEndereco, type EnderecoNormalizado } from "./endereco";
import type { Geocodificador, ResultadoProvedor } from "./geocodificador";
import { geocodificadorPadrao } from "./nominatim";

/**
 * Geocodificação (produto §B.2):
 * 1. endereço sem nada → `nenhuma`;
 * 2. só cidade → centroide do IBGE (`Municipio`, sem provedor);
 * 3. com logradouro → `GeoCache` (global) → provedor → cache; se o provedor não
 *    achar, centroide da cidade. Falha passageira do provedor → centroide
 *    PROVISÓRIO (o contato é tentado de novo depois).
 * 4. contato sem endereço próprio → herda da empresa principal.
 */

export type ResultadoGeo = {
  latitude: number | null;
  longitude: number | null;
  precisao: "endereco" | "cidade" | "nenhuma";
  fonte: string | null;
  /** Provedor fora: coordenada provisória, não vai para o cache e o registro é tentado de novo. */
  provisorio: boolean;
};

const NENHUMA: ResultadoGeo = { latitude: null, longitude: null, precisao: "nenhuma", fonte: null, provisorio: false };

/**
 * Um ponto do provedor a mais que isto do centro da cidade informada é
 * descartado: "Rod. BR-163, km 10" pode casar com a rodovia a 1.000 km dali.
 * Folgado de propósito (há município com mais de 100 km de raio).
 */
const DISTANCIA_MAXIMA_KM = 150;

/** Centroide IBGE da cidade (tabela global). Sem UF, só se o nome for único no país. */
export async function centroideDaCidade(cidadeBusca: string, uf: string | null): Promise<{ lat: number; lng: number } | null> {
  if (!cidadeBusca) return null;
  if (uf) {
    const m = await basePrisma.municipio.findUnique({ where: { uf_nomeBusca: { uf, nomeBusca: cidadeBusca } } });
    return m ? { lat: m.latitude, lng: m.longitude } : null;
  }
  const ms = await basePrisma.municipio.findMany({ where: { nomeBusca: cidadeBusca }, take: 2 });
  return ms.length === 1 ? { lat: ms[0]!.latitude, lng: ms[0]!.longitude } : null;
}

/** Geocodifica um endereço normalizado (sem tocar em contato). */
export async function geocodificar(n: EnderecoNormalizado, provedor: Geocodificador): Promise<ResultadoGeo> {
  if (n.nivel === "nenhum") return NENHUMA;
  const cidade = await centroideDaCidade(n.cidadeBusca, n.uf);
  const peloCentroide = (provisorio = false): ResultadoGeo =>
    cidade ? { latitude: cidade.lat, longitude: cidade.lng, precisao: "cidade", fonte: "ibge", provisorio } : { ...NENHUMA, provisorio };
  // Só cidade e ela está no IBGE: não precisa de provedor.
  if (n.nivel === "cidade" && cidade) return peloCentroide();

  // Logradouro, ou cidade fora da base do IBGE (distrito, grafia estranha).
  const cache = await basePrisma.geoCache.findUnique({ where: { chave: n.chave } });
  if (cache) {
    if (cache.latitude != null && cache.longitude != null) {
      return { latitude: cache.latitude, longitude: cache.longitude, precisao: cache.precisao === "endereco" ? "endereco" : "cidade", fonte: cache.fonte, provisorio: false };
    }
    return peloCentroide(); // o provedor já disse que não acha
  }

  let achado: ResultadoProvedor | null;
  try {
    achado = await provedor.buscar(n.consulta);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[geo] provedor indisponível — centroide provisório");
    return peloCentroide(true);
  }
  if (achado && cidade && distanciaKm({ lat: achado.latitude, lng: achado.longitude }, cidade) > DISTANCIA_MAXIMA_KM) {
    logger.info({ chave: n.chave }, "[geo] ponto do provedor longe da cidade informada — descartado");
    achado = null;
  }
  // Consulta só de cidade nunca vira precisão de rua.
  if (achado && n.nivel === "cidade") achado = { ...achado, precisao: "cidade" };
  // O GeoCache é GLOBAL: só entra resposta do PROVEDOR. Coordenada manual (pino
  // arrastado por um usuário) nunca vai para cá — mudaria o endereço para todos
  // os times. Ela fica só no registro do contato/empresa (geoPrecisao "manual").
  await basePrisma.geoCache.upsert({
    where: { chave: n.chave },
    create: {
      chave: n.chave,
      latitude: achado?.latitude ?? null,
      longitude: achado?.longitude ?? null,
      precisao: achado?.precisao ?? "nenhuma",
      fonte: provedor.nome,
    },
    update: {}, // a 1ª resposta vale (corrida entre dois workers)
  });
  if (!achado) return peloCentroide();
  return { latitude: achado.latitude, longitude: achado.longitude, precisao: achado.precisao, fonte: provedor.nome, provisorio: false };
}

/** Marca de "herdou da empresa" no geoHash do contato (o trigger zera quando a empresa ou o vínculo muda). */
const HASH_HERDADO = geoHashDe("empresa");
/** Sem endereço e sem empresa: processado, nada a localizar. */
const HASH_VAZIO = geoHashDe("");

/**
 * `concorrente` = o registro mudou durante a chamada ao provedor (endereço
 * editado, pino arrastado, vínculo trocado): a escrita foi descartada; o
 * trigger já zerou o geoHash e o backfill refaz com o dado novo.
 */
type Desfecho = "atualizado" | "inalterado" | "manual" | "ausente" | "concorrente";

/** Não-manual (o `not` sozinho do Prisma exclui NULL). */
const NAO_MANUAL = [{ geoPrecisao: null }, { geoPrecisao: { not: "manual" } }];

/**
 * Geocodifica uma empresa do time atual. Endereço igual ao da última vez
 * (`geoHash`) não vai ao provedor. Devolve a coordenada vigente.
 */
export async function geocodificarEmpresa(
  companyId: string,
  provedor: Geocodificador = geocodificadorPadrao(),
): Promise<(ResultadoGeo & { desfecho: Desfecho }) | null> {
  requireCan("contacts.write");
  const prisma = db();
  const co = await prisma.company.findUnique({
    where: { id: companyId },
    select: { endereco: true, cidade: true, estado: true, latitude: true, longitude: true, geoPrecisao: true, geoFonte: true, geoHash: true },
  });
  if (!co) return null;
  const vigente = (desfecho: Desfecho): ResultadoGeo & { desfecho: Desfecho } => ({
    latitude: co.latitude,
    longitude: co.longitude,
    precisao: co.geoPrecisao === "endereco" || co.geoPrecisao === "cidade" ? co.geoPrecisao : co.latitude != null ? "cidade" : "nenhuma",
    fonte: co.geoFonte,
    provisorio: false,
    desfecho,
  });
  if (co.geoPrecisao === "manual") return vigente("manual");
  const n = normalizarEndereco(co);
  const hash = geoHashDe(n.chave);
  if (co.geoHash === hash) return vigente("inalterado");
  const r = await geocodificar(n, provedor);
  // Escrita CONDICIONAL ao que foi lido: a chamada ao provedor leva segundos,
  // e o endereço pode ter mudado (ou o pino ter sido arrastado) nesse meio-tempo.
  const { count } = await prisma.company.updateMany({
    where: { id: companyId, endereco: co.endereco, cidade: co.cidade, estado: co.estado, OR: NAO_MANUAL },
    data: {
      latitude: r.latitude,
      longitude: r.longitude,
      geoPrecisao: r.precisao,
      geoFonte: r.fonte,
      geoHash: r.provisorio ? null : hash,
      geoAtualizadoEm: new Date(),
    },
  });
  if (count === 0) return { ...r, desfecho: "concorrente" };
  return { ...r, desfecho: "atualizado" };
}

/**
 * Geocodifica um contato do time atual (o job roda com `runAsSystem`).
 * Coordenada manual nunca é sobrescrita; `geoHash` igual não regeocodifica.
 */
export async function geocodificarContato(contactId: string, provedor: Geocodificador = geocodificadorPadrao()): Promise<Desfecho> {
  requireCan("contacts.write");
  const prisma = db();
  const c = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { endereco: true, cidade: true, estado: true, geoPrecisao: true, geoHash: true },
  });
  if (!c) return "ausente";
  if (c.geoPrecisao === "manual") return "manual";
  const n = normalizarEndereco(c);

  let r: ResultadoGeo;
  let hash: string;
  if (n.nivel !== "nenhum") {
    hash = geoHashDe(n.chave);
    if (c.geoHash === hash) return "inalterado";
    r = await geocodificar(n, provedor);
  } else {
    // Sem endereço próprio: herda da empresa principal (a 1ª vinculada).
    hash = HASH_HERDADO;
    // Já processado (herdado ou "sem empresa"): o trigger zera quando a empresa ou o vínculo muda.
    if (c.geoHash === HASH_HERDADO || c.geoHash === HASH_VAZIO) return "inalterado";
    const vinculo = await prisma.contactCompany.findFirst({
      where: { contactId },
      orderBy: { createdAt: "asc" },
      select: { companyId: true },
    });
    const emp = vinculo ? await geocodificarEmpresa(vinculo.companyId, provedor) : null;
    // A empresa mudou durante a chamada: não herda coordenada velha.
    if (emp?.desfecho === "concorrente") return "concorrente";
    if (!emp) {
      hash = HASH_VAZIO;
      r = NENHUMA;
    } else {
      r = emp.latitude != null ? { ...emp, fonte: "empresa" } : { ...NENHUMA, provisorio: emp.provisorio };
    }
  }
  // Escrita CONDICIONAL ao que foi lido (auditoria do #115): endereço igual,
  // não virou manual e — na herança — o geoHash não foi zerado pelo trigger do
  // vínculo. Senão a coordenada VELHA ficaria gravada com um geoHash válido e
  // o backfill nunca mais pegaria o contato; ou o pino do usuário se perderia.
  const { count } = await prisma.contact.updateMany({
    where: {
      id: contactId,
      endereco: c.endereco,
      cidade: c.cidade,
      estado: c.estado,
      OR: NAO_MANUAL,
      ...(n.nivel === "nenhum" ? { geoHash: c.geoHash } : {}),
    },
    data: {
      latitude: r.latitude,
      longitude: r.longitude,
      geoPrecisao: r.precisao,
      geoFonte: r.fonte,
      geoHash: r.provisorio ? null : hash,
      geoAtualizadoEm: new Date(),
    },
  });
  if (count === 0) {
    logger.info({ contactId }, "[geo] contato mudou durante a geocodificação — escrita descartada, o backfill refaz");
    return "concorrente";
  }
  return "atualizado";
}

// ---------------------------------------------------------------------------
// Backfill (job repetido da fila `geo`, no worker)
// ---------------------------------------------------------------------------

export const GEO_BACKFILL_LOTE = 200;
export const GEO_BACKFILL_ORCAMENTO_MS = 25_000;
/** Registro com falha passageira volta à fila depois disto. */
const REPETIR_DEPOIS_MS = 60 * 60_000;
const TRAVA_BACKFILL = "geo:backfill";
const SOLTAR_SE_MINHA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export type ResultadoBackfill = { processados: number; atualizados: number; erros: number; pulado?: "trava" };

/**
 * Geocodifica contatos pendentes de TODOS os times (cross-team, cada um no
 * contexto do próprio time): `geoHash` nulo = nunca processado, endereço
 * mudou (o trigger zera) ou falha passageira há mais de 1 h. Um registro ruim
 * não para o lote. Trava no Redis: dois backfills nunca rodam juntos.
 */
export async function backfillGeocode(
  opts: {
    provedor?: Geocodificador;
    lote?: number;
    orcamentoMs?: number;
    agora?: () => number;
    /** Só estes times (operação pontual e testes). Padrão: todos. */
    teamIds?: string[];
  } = {},
): Promise<ResultadoBackfill> {
  const agora = opts.agora ?? Date.now;
  const orcamento = opts.orcamentoMs ?? GEO_BACKFILL_ORCAMENTO_MS;
  const provedor = opts.provedor ?? geocodificadorPadrao();
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const vez = await redisEstado().set(TRAVA_BACKFILL, token, "PX", orcamento + 60_000, "NX");
  if (!vez) return { processados: 0, atualizados: 0, erros: 0, pulado: "trava" };
  const inicio = agora();
  const r: ResultadoBackfill = { processados: 0, atualizados: 0, erros: 0 };
  try {
    const pendentes = await basePrisma.contact.findMany({
      where: {
        geoHash: null,
        // Pino manual nunca é regeocodificado: sem este filtro, manuais sem
        // geoHash voltariam em toda rodada e, com mais de 200, travariam o
        // backfill neles (auditoria do #115).
        AND: [
          { OR: [{ geoAtualizadoEm: null }, { geoAtualizadoEm: { lt: new Date(inicio - REPETIR_DEPOIS_MS) } }] },
          { OR: NAO_MANUAL },
        ],
        ...(opts.teamIds ? { teamId: { in: opts.teamIds } } : {}),
      },
      select: { id: true, teamId: true },
      take: opts.lote ?? GEO_BACKFILL_LOTE,
    });
    for (const p of pendentes) {
      if (agora() - inicio > orcamento) break;
      r.processados++;
      try {
        const d = await runAsSystem(p.teamId, () => geocodificarContato(p.id, provedor));
        if (d === "atualizado") r.atualizados++;
      } catch (err) {
        r.erros++;
        logger.warn({ contactId: p.id, err: err instanceof Error ? err.message : String(err) }, "[geo] contato não geocodificado — tento de novo em 1 h");
        // Carimba a tentativa: sem isso o mesmo registro ruim voltaria a cada rodada.
        await basePrisma.contact
          .updateMany({ where: { id: p.id, teamId: p.teamId }, data: { geoAtualizadoEm: new Date(agora()) } })
          .catch((e) => logger.warn({ contactId: p.id, err: e instanceof Error ? e.message : String(e) }, "[geo] não carimbei a tentativa"));
      }
    }
  } finally {
    // Solta só se a trava ainda é MINHA (compare-and-delete).
    await redisEstado()
      .eval(SOLTAR_SE_MINHA, 1, TRAVA_BACKFILL, token)
      .catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[geo] não soltei a trava do backfill"));
  }
  return r;
}
