import type { Prisma, Goal } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { applyCursor, buildResult, type CursorPaginationResult } from "../shared/pagination";
import { GoalNotFound } from "./errors";
import type { CreateGoalInput, UpdateGoalInput } from "./schema";
import { requireCan } from "../auth/authz";
import { assertOwnedIfPresent } from "../tenancy/assert-owned";

/**
 * Serviços de Meta (Goal). Puros (só @crmagro/db). Chamam `db()` no início de cada
 * função (leitura eager do teamId — ver @crmagro/db/client). O teamId NUNCA é
 * parâmetro manual: vem do AsyncLocalStorage e é injetado pela extensão de
 * tenancy (§12). Logo, toda função aqui roda DENTRO de `runWithTeam`/`runAsDev`.
 *
 * Esta é a ÚNICA camada que fala Prisma para metas — a UI (server actions) só
 * chama estas funções tipadas (§1.5 e AGENTS.md). ZERO `db()` em apps/web.
 */

/**
 * Lista as metas do time, mais recentes (por período) primeiro, com paginação
 * cursor-based (§paginação). `cursor` precede `offset`; sem ambos, primeira
 * página. `orderBy` termina em `id` (desempate estável do cursor).
 */
export async function listGoals(
  opts: { cursor?: string; limit?: number; offset?: number } = {},
): Promise<CursorPaginationResult<Goal>> {
  const prisma = db();
  const { cursor, limit = 50, offset = 0 } = opts;
  const rows = await prisma.goal.findMany({
    orderBy: [{ periodo: "desc" }, { id: "desc" }],
    ...(cursor ? applyCursor({ cursor, limit }) : { take: limit + 1, skip: offset }),
  });
  return buildResult(rows, limit);
}

/**
 * Lista TODAS as metas do time (sem paginação), mais recentes por período
 * primeiro. Usada pela tela de Configurações→Metas, onde o volume é pequeno
 * (uma meta por mês) e a UI mostra a lista inteira.
 */
export async function listAllGoals(): Promise<Goal[]> {
  const prisma = db();
  return prisma.goal.findMany({ orderBy: { periodo: "desc" } });
}

/** Busca uma meta do time por id, ou lança `GoalNotFound` (valida escopo do time). */
export async function getGoalById(id: string): Promise<Goal> {
  const prisma = db();
  const goal = await prisma.goal.findUnique({ where: { id } });
  if (!goal) throw new GoalNotFound(id);
  return goal;
}

/** Cria uma meta do time. `metaValor` (number) vira Decimal no Prisma. */
export async function createGoal(data: CreateGoalInput): Promise<Goal> {
  requireCan("settings.goals");
  const prisma = db();
  // Auditoria de isolamento 09/2026 (§12g): `ownerId` vem da tela e vira FK
  // para User. Sem a prova, a meta do time A apontava para uma pessoa do time B
  // (e o sucesso/erro da FK dizia se aquele id de usuário existe na plataforma).
  await assertOwnedIfPresent("user", data.ownerId);
  return prisma.goal.create({
    data: tenantData<Prisma.GoalUncheckedCreateInput>({
      periodo: data.periodo,
      metaValor: data.metaValor,
      toquesPorDia: data.toquesPorDia,
      ...(data.ownerId ? { ownerId: data.ownerId } : {}),
    }),
  });
}

/**
 * Atualiza uma meta do time. Valida a existência/escopo antes (lança
 * `GoalNotFound` se não for do time), evitando o P2025 cru do Prisma.
 */
export async function updateGoal(data: UpdateGoalInput): Promise<Goal> {
  requireCan("settings.goals");
  const prisma = db();
  const { id, periodo, metaValor, toquesPorDia } = data;
  await getGoalById(id); // lança GoalNotFound (e valida escopo do time)
  return prisma.goal.update({
    where: { id },
    data: { periodo, metaValor, toquesPorDia },
  });
}

/** Remove uma meta do time. Lança `GoalNotFound` se não existir neste time. */
export async function deleteGoal(id: string): Promise<void> {
  requireCan("settings.goals");
  const prisma = db();
  await getGoalById(id); // lança GoalNotFound (e valida escopo do time)
  await prisma.goal.delete({ where: { id } });
}
