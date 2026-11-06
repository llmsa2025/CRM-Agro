import type { DealStatus, Prisma } from "@prisma/client";
import { db, type TenantPrismaClient } from "@crmagro/db";
import { codificarCursor, decodificarCursor, CursorInvalido, type ChaveCursor } from "../shared/cursor-keyset";
import { FunnelNotFound, StageNotFound } from "./errors";
import { listFunnelDealsInputSchema, type ListFunnelDealsInput } from "./schema";
import { dealsAbertosPorEtapa } from "./stats";

import { escopoNegocio } from "./escopo";
/**
 * Kanban paginado (item 2.4, DP-12).
 *
 * `getFunnel` trazia TODOS os deals do funil (abertos, ganhos e perdidos), cada
 * um com a linha inteira do contato (inclusive o Json `enrichment`). Aqui:
 *   - só os ABERTOS nas colunas, 50 por etapa (uma consulta por etapa: `take`
 *     aninhado com vários pais não vira LIMIT no Prisma — fato 1 da auditoria);
 *   - do contato, só `id`, `nome` e `empresa` (o que o cartão mostra);
 *   - contagem e valor por etapa via `groupBy` (não pelo tamanho da página);
 *   - ganhos/perdidos só como resumo (coluna recolhida) e sob demanda;
 *   - o resto por "carregar mais" (`listFunnelDeals`, cursor por valor).
 *
 * Ordem dos cartões: quem entrou na etapa mais recentemente primeiro, com
 * desempate por `id` (estável para o cursor).
 */

/** Cartões por etapa na primeira carga. */
export const CARDS_POR_ETAPA = 50;
const CARDS_TETO = 100;

const cardSelect = {
  id: true,
  stageId: true,
  valor: true,
  status: true,
  enteredStageAt: true,
  contact: { select: { id: true, nome: true, empresa: true } },
} satisfies Prisma.DealSelect;

type LinhaCard = Prisma.DealGetPayload<{ select: typeof cardSelect }>;

/** Cartão do kanban já serializável (Decimal → string, data → ISO). */
export type DealCard = {
  id: string;
  stageId: string;
  valor: string;
  status: DealStatus;
  enteredStageAt: string;
  contact: { id: string; nome: string; empresa: string | null };
};

export type DealCardPage = { items: DealCard[]; nextCursor: string | null };

export type FunnelBoardStage = {
  id: string;
  nome: string;
  cor: string | null;
  ordem: number;
  codigo: string | null;
  /** Deals ABERTOS da etapa (todos, não só os da página). */
  total: number;
  /** Soma do valor dos deals abertos da etapa. */
  valor: number;
  deals: DealCard[];
  /** Cursor para `listFunnelDeals({ stageId, cursor })`; null = não há mais. */
  nextCursor: string | null;
};

export type FunnelBoard = {
  id: string;
  nome: string;
  tipo: string;
  codigo: string | null;
  stages: FunnelBoardStage[];
  /** Resumo da coluna recolhida; a lista vem de `listFunnelDeals({ status })`. */
  fechados: { won: { total: number; valor: number }; lost: { total: number; valor: number } };
};

function toCard(d: LinhaCard): DealCard {
  return {
    id: d.id,
    stageId: d.stageId,
    valor: d.valor.toString(),
    status: d.status,
    enteredStageAt: d.enteredStageAt.toISOString(),
    contact: d.contact,
  };
}

/** Linhas depois do cursor na ordem (enteredStageAt desc, id desc). */
function depoisDe(c: ChaveCursor): Prisma.DealWhereInput {
  // enteredStageAt é NOT NULL: cursor sem data só pode ter sido forjado.
  if (c.em === null) throw new CursorInvalido();
  return { OR: [{ enteredStageAt: { lt: c.em } }, { enteredStageAt: c.em, id: { lt: c.id } }] };
}

async function paginaDeCards(
  prisma: TenantPrismaClient,
  where: Prisma.DealWhereInput,
  limit: number,
  cursor?: ChaveCursor,
  dono?: string,
): Promise<DealCardPage> {
  // F3: só os negócios do escopo de quem pede (e do vendedor filtrado).
  const base: Prisma.DealWhereInput = { AND: [where, escopoNegocio(dono)] };
  const rows = await prisma.deal.findMany({
    where: cursor ? { AND: [base, depoisDe(cursor)] } : base,
    select: cardSelect,
    orderBy: [{ enteredStageAt: "desc" }, { id: "desc" }],
    take: limit + 1, // a linha a mais só diz se há próxima página
  });
  const temMais = rows.length > limit;
  const pagina = temMais ? rows.slice(0, limit) : rows;
  const ultima = pagina[pagina.length - 1];
  return {
    items: pagina.map(toCard),
    nextCursor: temMais && ultima ? codificarCursor({ em: ultima.enteredStageAt, id: ultima.id }) : null,
  };
}

/**
 * Funil para o kanban: etapas com os primeiros `porEtapa` deals abertos,
 * contagem/valor por etapa e o resumo de ganhos/perdidos. Substitui `getFunnel`
 * na tela (ver "Para o front" do PR do item 2.4).
 */
export async function getFunnelBoard(id: string, opts: { porEtapa?: number; dono?: string } = {}): Promise<FunnelBoard> {
  const prisma = db();
  const porEtapa = Math.min(Math.max(Math.trunc(opts.porEtapa ?? CARDS_POR_ETAPA), 1), CARDS_TETO);
  const funnel = await prisma.funnel.findUnique({
    where: { id },
    select: {
      id: true,
      nome: true,
      tipo: true,
      codigo: true,
      stages: { orderBy: { ordem: "asc" }, select: { id: true, nome: true, cor: true, ordem: true, codigo: true } },
    },
  });
  if (!funnel) throw new FunnelNotFound(id);

  const [abertos, fechados, paginas] = await Promise.all([
    dealsAbertosPorEtapa(prisma, { funnelId: id, dono: opts.dono }),
    prisma.deal.groupBy({
      by: ["status"],
      where: { AND: [{ funnelId: id, status: { in: ["won", "lost"] } }, escopoNegocio(opts.dono)] },
      _count: { _all: true },
      _sum: { valor: true },
    }),
    Promise.all(
      funnel.stages.map((s) => paginaDeCards(prisma, { funnelId: id, stageId: s.id, status: "open" }, porEtapa, undefined, opts.dono)),
    ),
  ]);
  const resumoFechado = (status: "won" | "lost") => {
    const g = fechados.find((x) => x.status === status);
    return { total: g?._count._all ?? 0, valor: Number(g?._sum.valor ?? 0) };
  };

  return {
    id: funnel.id,
    nome: funnel.nome,
    tipo: funnel.tipo,
    codigo: funnel.codigo,
    stages: funnel.stages.map((s, i) => {
      const r = abertos.get(s.id) ?? { count: 0, valor: 0 };
      return { ...s, total: r.count, valor: r.valor, deals: paginas[i]!.items, nextCursor: paginas[i]!.nextCursor };
    }),
    fechados: { won: resumoFechado("won"), lost: resumoFechado("lost") },
  };
}

/**
 * "Carregar mais" do kanban: próxima página de cartões de uma etapa (abertos,
 * por padrão) ou a lista de ganhos/perdidos do funil (`status`, com ou sem
 * `stageId`). Etapa de outro funil (ou de outro time) → StageNotFound.
 */
export async function listFunnelDeals(funnelId: string, input: ListFunnelDealsInput = {}): Promise<DealCardPage> {
  const prisma = db();
  const f = listFunnelDealsInputSchema.parse(input);
  const cursor = f.cursor ? decodificarCursor(f.cursor) : undefined;
  const funnel = await prisma.funnel.findUnique({ where: { id: funnelId }, select: { id: true } });
  if (!funnel) throw new FunnelNotFound(funnelId);
  if (f.stageId) {
    const stage = await prisma.stage.findFirst({ where: { id: f.stageId, funnelId }, select: { id: true } });
    if (!stage) throw new StageNotFound(f.stageId);
  }
  return paginaDeCards(
    prisma,
    { funnelId, status: f.status, ...(f.stageId ? { stageId: f.stageId } : {}) },
    f.limit,
    cursor,
    f.dono,
  );
}
