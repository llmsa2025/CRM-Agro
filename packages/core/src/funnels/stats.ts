import type { TenantPrismaClient } from "@crmagro/db";

import { escopoNegocio } from "./escopo";
/** Contagem e valor dos deals abertos de uma etapa. */
export type ResumoEtapa = { count: number; valor: number };

/**
 * Deals abertos agrupados por etapa (item 2.3, DP-07): um `GROUP BY "stageId"`
 * no banco em vez de trazer todos os deals abertos para contar e somar em JS.
 * O `groupBy` passa pela extensão de tenancy (recebe `teamId` no where), então
 * recebe o client do serviço, já amarrado ao time (`db()` lido antes do await).
 */
export async function dealsAbertosPorEtapa(
  prisma: TenantPrismaClient,
  filtro: { dono?: string; funnelId?: string } = {},
): Promise<Map<string, ResumoEtapa>> {
  const grupos = await prisma.deal.groupBy({
    by: ["stageId"],
    // `funnelId` opcional: o kanban (item 2.4) agrega só o funil aberto.
    // F3: cada vendedor soma só os negócios dele; admin/"ver tudo", os de todos.
    where: { AND: [{ status: "open", ...(filtro.funnelId ? { funnelId: filtro.funnelId } : {}) }, escopoNegocio(filtro.dono)] },
    _count: { _all: true },
    _sum: { valor: true },
  });
  return new Map(
    grupos.map((g) => [g.stageId, { count: g._count._all, valor: Number(g._sum.valor ?? 0) }]),
  );
}
