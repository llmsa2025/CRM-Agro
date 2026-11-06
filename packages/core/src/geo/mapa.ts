import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { basePrisma, db, getCurrentTeamId } from "@crmagro/db";
import { numeroBR } from "../contacts/schema";
import { logger } from "../logger/index";
import { redisCache } from "../shared/redis-cache";

import { chaveDoEscopo, sqlDoEscopo, whereDoEscopo } from "../tenancy/escopo";
/**
 * Consulta do Mapa (produto §B.3): pontos, resumo da região e "perto de".
 *
 * SQL cru porque o Prisma não agrupa por grade (clusters) nem agrega o resumo
 * numa ida só. Regra de tenancy (AGENTS.md §12f): o `teamId` vem SEMPRE do
 * contexto (`getCurrentTeamId()`), nunca do cliente, e entra EXPLÍCITO em
 * toda tabela da consulta (Contact, Activity, Deal, ContactTag,
 * CampaignRecipient). Leitura: vale para qualquer papel do time (viewer vê o
 * mapa, como vê a lista de contatos).
 */

/** Acima disto a resposta vira clusters por grade (o cliente pede pontos ao aproximar). */
export const MAPA_MAX_PONTOS = 5000;
/** Tamanho da célula da grade dos clusters, em graus (~28 km). */
export const MAPA_GRADE_GRAUS = 0.25;
const CACHE_TTL_S = 60;

export class MapaSemTime extends Error {
  constructor() {
    super("sem time no contexto");
    this.name = "MapaSemTime";
  }
}

const csv = <T extends [string, ...string[]]>(valores: T) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(valores)).max(valores.length));

/** "w,s,e,n" em graus (oeste, sul, leste, norte). */
const bboxSchema = z
  .string()
  .transform((s) => s.split(",").map((x) => Number(x.trim())))
  .pipe(
    z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .refine(([w, s, e, n]) => w <= e && s <= n, "bbox deve ser w,s,e,n com w ≤ e e s ≤ n"),
  );

/** Id de camada ou `SEM_CAMADA` ("sem camada"). */
export const SEM_CAMADA = "__none__";
const camadaCsv = z
  .string()
  .transform((s) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))])
  .pipe(z.array(z.union([z.literal(SEM_CAMADA), z.string().uuid()])).min(1).max(100));

/** Faixa numérica: "de" e "até" opcionais, ≥ 0, no formato digitado ("1.000" = mil). */
const faixa = (max: number) => z.preprocess(numeroBR, z.number().finite().nonnegative().max(max).nullable()).optional();

/** Filtros da tela do mapa — mesmos na query string de pontos e resumo (zod na borda). */
export const filtrosMapaSchema = z
  .object({
    bbox: bboxSchema.optional(),
    status: csv(["novo", "ja_conversou", "cliente", "opt_out"]).optional(),
    interesse: csv(["nao_avaliado", "interessado", "sem_interesse", "talvez"]).optional(),
    /** id da tag, ou "__none__" para "sem tag". */
    tag: z.string().min(1).max(100).optional(),
    produtor: z.enum(["produtor", "provavel_produtor", "nao_produtor"]).optional(),
    cultura: z.string().trim().min(1).max(60).optional(),
    campanha: z.string().uuid().optional(),
    /** Teve interação (qualquer atividade) nos últimos N dias. */
    dias: z.coerce.number().int().min(1).max(3650).optional(),
    /** "aberto" = tem negócio aberto; "sem" = não tem. */
    negocio: z.enum(["aberto", "sem"]).optional(),
    /** Camadas visíveis: ids e/ou "__none__" (sem camada). Ausente = todas. */
    camada: camadaCsv.optional(),
    /** Parte do nome da cidade ("sorr" acha Sorriso). */
    cidade: z.string().trim().min(1).max(80).optional(),
    uf: z.string().trim().length(2).optional(),
    /** Área da propriedade (ha), de/até. */
    areaMin: faixa(10_000_000),
    areaMax: faixa(10_000_000),
    /** Faturamento anual (R$), de/até. */
    fatMin: faixa(1e12),
    fatMax: faixa(1e12),
  })
  .refine((f) => f.areaMin == null || f.areaMax == null || f.areaMin <= f.areaMax, { message: "área: o mínimo passa do máximo", path: ["areaMin"] })
  .refine((f) => f.fatMin == null || f.fatMax == null || f.fatMin <= f.fatMax, { message: "faturamento: o mínimo passa do máximo", path: ["fatMin"] });
export type FiltrosMapa = z.infer<typeof filtrosMapaSchema>;

/** `%` e `_` digitados viram literais no LIKE (não curinga). */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Lê os filtros de uma query string (valores vazios = sem filtro). */
export function filtrosDaQuery(params: URLSearchParams): FiltrosMapa {
  const o: Record<string, string> = {};
  for (const [k, v] of params) if (v.trim() !== "") o[k] = v;
  return filtrosMapaSchema.parse(o);
}

function timeAtual(): string {
  const t = getCurrentTeamId();
  if (!t) throw new MapaSemTime();
  return t;
}

/** WHERE do contato (alias `c`) — `teamId` explícito em TODA subconsulta. */
function whereContato(teamId: string, f: FiltrosMapa): Prisma.Sql {
  const conds: Prisma.Sql[] = [
    // F3: escopo por dono (vazio para quem vê tudo) junto do time.
    Prisma.sql`c."teamId" = ${teamId}${sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true })}`,
    Prisma.sql`c."latitude" IS NOT NULL`,
    Prisma.sql`c."longitude" IS NOT NULL`,
  ];
  if (f.bbox) {
    const [w, s, e, n] = f.bbox;
    conds.push(Prisma.sql`c."latitude" BETWEEN ${s} AND ${n} AND c."longitude" BETWEEN ${w} AND ${e}`);
  }
  if (f.status?.length) conds.push(Prisma.sql`c."relacionamentoStatus"::text IN (${Prisma.join(f.status)})`);
  if (f.interesse?.length) conds.push(Prisma.sql`c."interesse"::text IN (${Prisma.join(f.interesse)})`);
  if (f.produtor) conds.push(Prisma.sql`c."produtorLabel" = ${f.produtor}`);
  if (f.cultura) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM unnest(c."culturas") AS cul WHERE lower(cul) = lower(${f.cultura}))`);
  }
  if (f.tag === "__none__") {
    conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "ContactTag" ct WHERE ct."contactId" = c.id AND ct."teamId" = ${teamId})`);
  } else if (f.tag) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ContactTag" ct WHERE ct."contactId" = c.id AND ct."teamId" = ${teamId} AND ct."tagId" = ${f.tag})`);
  }
  if (f.campanha) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "CampaignRecipient" cr WHERE cr."contactId" = c.id AND cr."teamId" = ${teamId} AND cr."campaignId" = ${f.campanha})`,
    );
  }
  if (f.dias) {
    const desde = new Date(Date.now() - f.dias * 24 * 60 * 60_000);
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Activity" a WHERE a."contactId" = c.id AND a."teamId" = ${teamId} AND a."createdAt" >= ${desde})`,
    );
  }
  if (f.negocio) {
    // F3: o negócio também tem de ser do escopo (contato compartilhado com negócio de outro vendedor).
    const existe = Prisma.sql`EXISTS (SELECT 1 FROM "Deal" d WHERE d."contactId" = c.id AND d."teamId" = ${teamId} AND d."status" = 'open'${sqlDoEscopo("funis", "d", "ownerId")})`;
    conds.push(f.negocio === "aberto" ? existe : Prisma.sql`NOT ${existe}`);
  }
  if (f.camada?.length) {
    // Camada é coluna do próprio contato (já filtrado por teamId): id de camada
    // de outro time simplesmente não casa com nada.
    const ids = f.camada.filter((x) => x !== SEM_CAMADA);
    const partes: Prisma.Sql[] = [];
    if (ids.length) partes.push(Prisma.sql`c."camadaId" IN (${Prisma.join(ids)})`);
    if (f.camada.includes(SEM_CAMADA)) partes.push(Prisma.sql`c."camadaId" IS NULL`);
    conds.push(Prisma.sql`(${Prisma.join(partes, " OR ")})`);
  }
  if (f.cidade) conds.push(Prisma.sql`lower(c.cidade) LIKE lower(${`%${likeLiteral(f.cidade)}%`})`);
  if (f.uf) conds.push(Prisma.sql`upper(c.estado) = upper(${f.uf})`);
  if (f.areaMin != null) conds.push(Prisma.sql`c."areaHa" >= ${f.areaMin}`);
  if (f.areaMax != null) conds.push(Prisma.sql`c."areaHa" <= ${f.areaMax}`);
  if (f.fatMin != null) conds.push(Prisma.sql`c."faturamentoAnual" >= ${f.fatMin}`);
  if (f.fatMax != null) conds.push(Prisma.sql`c."faturamentoAnual" <= ${f.fatMax}`);
  return Prisma.join(conds, " AND ");
}

/** Cache de 60 s por time e por consulta. Redis fora = sem cache. */
async function comCache<T>(teamId: string, tipo: string, f: unknown, calcular: () => Promise<T>): Promise<T> {
  // A chave leva o escopo (F3): cada pessoa vê os seus pontos. O Mapa lê
  // contatos ("ver tudo" em Contatos) e negócios (em Funis): os dois entram.
  const chave = `mapa:${teamId}:${chaveDoEscopo("contatos", "funis")}:${tipo}:${createHash("sha1").update(JSON.stringify(f)).digest("hex")}`;
  try {
    const cru = await redisCache().get(chave);
    if (cru) return JSON.parse(cru) as T;
  } catch {
    /* cache é fail-fast: segue para o banco */
  }
  const valor = await calcular();
  try {
    await redisCache().set(chave, JSON.stringify(valor), "EX", CACHE_TTL_S);
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "[mapa] não gravei o cache");
  }
  return valor;
}

export type PontosMapa =
  | {
      tipo: "pontos";
      total: number;
      // Arrays paralelos (compacto: 5.000 pontos em poucos KB a menos que objetos).
      ids: string[];
      lat: number[];
      lng: number[];
      st: string[];
      nome: string[];
      empresa: (string | null)[];
      cidade: (string | null)[];
      /** Camada de cada ponto (null = sem camada) — a tela pinta o pino com a cor dela. */
      cam: (string | null)[];
    }
  | {
      tipo: "clusters";
      total: number;
      clusters: { lat: number; lng: number; n: number; porStatus: Record<string, number> }[];
    };

/**
 * Pontos do mapa do time. Até 5.000: cada contato; acima: clusters por grade
 * de 0,25° (centro = média dos pontos da célula) com a contagem por status.
 */
export async function pontosDoMapa(filtros: FiltrosMapa = {}): Promise<PontosMapa> {
  const teamId = timeAtual();
  return comCache(teamId, "pontos", filtros, async () => {
    const where = whereContato(teamId, filtros);
    const [contagem] = await basePrisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM "Contact" c WHERE ${where}`;
    const total = contagem?.total ?? 0;
    if (total <= MAPA_MAX_PONTOS) {
      const rows = await basePrisma.$queryRaw<
        {
          id: string;
          latitude: number;
          longitude: number;
          st: string;
          nome: string;
          empresa: string | null;
          cidade: string | null;
          cam: string | null;
        }[]
      >`
        SELECT c.id, c."latitude", c."longitude", c."relacionamentoStatus"::text AS st, c.nome, c.empresa, c.cidade,
               c."camadaId" AS cam
          FROM "Contact" c WHERE ${where}
         ORDER BY c.id
         LIMIT ${MAPA_MAX_PONTOS}`;
      return {
        tipo: "pontos",
        total,
        ids: rows.map((r) => r.id),
        lat: rows.map((r) => r.latitude),
        lng: rows.map((r) => r.longitude),
        st: rows.map((r) => r.st),
        nome: rows.map((r) => r.nome),
        empresa: rows.map((r) => r.empresa),
        cidade: rows.map((r) => r.cidade),
        cam: rows.map((r) => r.cam),
      };
    }
    const celulas = await basePrisma.$queryRaw<{ gy: number; gx: number; st: string; n: number; slat: number; slng: number }[]>`
      SELECT floor(c."latitude" / ${MAPA_GRADE_GRAUS})::int AS gy,
             floor(c."longitude" / ${MAPA_GRADE_GRAUS})::int AS gx,
             c."relacionamentoStatus"::text AS st,
             count(*)::int AS n,
             sum(c."latitude")::float8 AS slat,
             sum(c."longitude")::float8 AS slng
        FROM "Contact" c WHERE ${where}
       GROUP BY 1, 2, 3`;
    const porCelula = new Map<string, { n: number; slat: number; slng: number; porStatus: Record<string, number> }>();
    for (const r of celulas) {
      const k = `${r.gy}:${r.gx}`;
      const cel = porCelula.get(k) ?? { n: 0, slat: 0, slng: 0, porStatus: {} };
      cel.n += r.n;
      cel.slat += r.slat;
      cel.slng += r.slng;
      cel.porStatus[r.st] = (cel.porStatus[r.st] ?? 0) + r.n;
      porCelula.set(k, cel);
    }
    return {
      tipo: "clusters",
      total,
      clusters: [...porCelula.values()].map((c) => ({ lat: c.slat / c.n, lng: c.slng / c.n, n: c.n, porStatus: c.porStatus })),
    };
  });
}

export type ResumoMapa = {
  total: number;
  porStatus: Record<string, number>;
  /** Contatos com pelo menos uma mensagem/atividade RECEBIDA. */
  responderam: number;
  clientes: number;
  negociosAbertos: { n: number; valor: number };
  culturas: { nome: string; pct: number }[];
  cidades: { nome: string; uf: string | null; n: number }[];
  /** Contatos da região por camada (chave = id da camada ou "__none__"). */
  porCamada: Record<string, number>;
  /** Área informada na região: quantos têm área e a soma em hectares. */
  area: { comArea: number; totalHa: number };
};

/** Resumo da região selecionada (mesmos filtros dos pontos). */
export async function resumoDoMapa(filtros: FiltrosMapa = {}): Promise<ResumoMapa> {
  const teamId = timeAtual();
  return comCache(teamId, "resumo", filtros, async () => {
    const where = whereContato(teamId, filtros);
    // UMA conexão, em sequência (auditoria do #119): com Promise.all eram 5
    // conexões do pool do web por abertura do mapa — alguns vendedores ao
    // mesmo tempo esgotavam o pool (connection_limit=10) e outras telas
    // tomavam P2024. O $transaction em lote roda as 5 na mesma conexão.
    const [status, [resp], [deals], culturas, cidades, camadas] = await basePrisma.$transaction([
      basePrisma.$queryRaw<{ st: string; n: number }[]>`
        SELECT c."relacionamentoStatus"::text AS st, count(*)::int AS n FROM "Contact" c WHERE ${where} GROUP BY 1`,
      basePrisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "Contact" c WHERE ${where}
           AND EXISTS (SELECT 1 FROM "Activity" a WHERE a."contactId" = c.id AND a."teamId" = ${teamId} AND a."direcao" = 'in')`,
      basePrisma.$queryRaw<{ n: number; valor: number }[]>`
        SELECT count(*)::int AS n, coalesce(sum(d."valor"), 0)::float8 AS valor
          FROM "Deal" d JOIN "Contact" c ON c.id = d."contactId"
         WHERE d."teamId" = ${teamId} AND d."status" = 'open'${sqlDoEscopo("funis", "d", "ownerId")} AND ${where}`,
      basePrisma.$queryRaw<{ nome: string; n: number }[]>`
        SELECT lower(cul) AS nome, count(DISTINCT c.id)::int AS n
          FROM "Contact" c, unnest(c."culturas") AS cul
         WHERE ${where}
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      basePrisma.$queryRaw<{ nome: string; uf: string | null; n: number }[]>`
        SELECT c.cidade AS nome, c.estado AS uf, count(*)::int AS n
          FROM "Contact" c WHERE ${where} AND c.cidade IS NOT NULL AND c.cidade <> ''
         GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 10`,
      // Por camada + área numa consulta só (a área soma os grupos).
      basePrisma.$queryRaw<{ cam: string; n: number; com_area: number; total_ha: number }[]>`
        SELECT coalesce(c."camadaId", ${SEM_CAMADA}) AS cam, count(*)::int AS n,
               count(c."areaHa")::int AS com_area, coalesce(sum(c."areaHa"), 0)::float8 AS total_ha
          FROM "Contact" c WHERE ${where}
         GROUP BY 1`,
    ]);
    const porStatus = Object.fromEntries(status.map((s) => [s.st, s.n]));
    const total = status.reduce((a, s) => a + s.n, 0);
    return {
      total,
      porStatus,
      responderam: resp?.n ?? 0,
      clientes: porStatus.cliente ?? 0,
      negociosAbertos: { n: deals?.n ?? 0, valor: deals?.valor ?? 0 },
      culturas: culturas.map((c) => ({ nome: c.nome, pct: total ? Math.round((c.n / total) * 1000) / 10 : 0 })),
      cidades,
      porCamada: Object.fromEntries(camadas.map((k) => [k.cam, k.n])),
      area: {
        comArea: camadas.reduce((a, k) => a + k.com_area, 0),
        totalHa: Math.round(camadas.reduce((a, k) => a + k.total_ha, 0) * 10) / 10,
      },
    };
  });
}

export const pertoSchema = z.object({
  contactId: z.string().uuid(),
  km: z.coerce.number().positive().max(500).default(15),
});

export type ContatoPerto = { id: string; nome: string; empresa: string | null; cidade: string | null; st: string; lat: number; lng: number; km: number };

/**
 * Contatos do time num raio de `km` do contato (Haversine no SQL, os 10 mais
 * próximos). O retângulo em volta do raio usa o índice (teamId, lat, lng).
 */
export async function contatosPerto(input: { contactId: string; km?: number }): Promise<ContatoPerto[]> {
  const { contactId, km } = pertoSchema.parse(input);
  const teamId = timeAtual();
  const alvo = await db().contact.findFirst({
    where: { AND: [{ id: contactId }, whereDoEscopo("contatos", "ownerId", { compartilhado: true }) as Prisma.ContactWhereInput] },
    select: { latitude: true, longitude: true },
  });
  if (!alvo) {
    const e = new Error("contato não encontrado no time");
    e.name = "ContactNotFound";
    throw e;
  }
  if (alvo.latitude == null || alvo.longitude == null) return [];
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.1, Math.cos((alvo.latitude * Math.PI) / 180)));
  const rows = await basePrisma.$queryRaw<ContatoPerto[]>`
    SELECT * FROM (
      SELECT c.id, c.nome, c.empresa, c.cidade, c."relacionamentoStatus"::text AS st,
             c."latitude" AS lat, c."longitude" AS lng,
             2 * 6371 * asin(least(1, sqrt(
               power(sin(radians(c."latitude" - ${alvo.latitude}) / 2), 2) +
               cos(radians(${alvo.latitude})) * cos(radians(c."latitude")) *
               power(sin(radians(c."longitude" - ${alvo.longitude}) / 2), 2)
             ))) AS km
        FROM "Contact" c
       WHERE c."teamId" = ${teamId}${sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true })} AND c.id <> ${contactId}
         AND c."latitude" BETWEEN ${alvo.latitude - dLat} AND ${alvo.latitude + dLat}
         AND c."longitude" BETWEEN ${alvo.longitude - dLng} AND ${alvo.longitude + dLng}
    ) t
    WHERE t.km <= ${km}
    ORDER BY t.km
    LIMIT 10`;
  return rows.map((r) => ({ ...r, km: Math.round(r.km * 10) / 10 }));
}
