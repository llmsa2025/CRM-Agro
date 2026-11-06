"use server";

import { revalidatePath } from "next/cache";
import type { Goal } from "@prisma/client";
import { currentUser, acaoDaTela } from "@/lib/tenant";
import {
  requireRole,
  listAllGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  createGoalSchema,
  updateGoalSchema,
  deleteGoalSchema,
  GoalNotFound,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "configuracoes". */
const runAsUserAction = acaoDaTela("configuracoes");
export type ActionState = { error?: string; ok?: boolean };

/**
 * Versão serializável do model Goal para o client. O Prisma devolve
 * `metaValor` como `Decimal` (decimal.js), que não sobrevive intacto à borda
 * do RSC: o `toJSON()` do Decimal vira string e o tipo TS mente que é Decimal.
 * Mapeamos pra `number` aqui — mesma conversão que a página de funis faz com
 * `d.valor.toString()`. Assim o `MetasTab` recebe números prontos e o formato
 * de moeda BR roda sem surpresas.
 */
export type Meta = {
  id: string;
  ownerId: string | null;
  periodo: string;
  metaValor: number;
  toquesPorDia: number;
  createdAt: Date;
  updatedAt: Date;
};

function toMeta(g: Goal): Meta {
  return {
    id: g.id,
    ownerId: g.ownerId,
    periodo: g.periodo,
    metaValor: Number(g.metaValor),
    toquesPorDia: g.toquesPorDia,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/**
 * Mapeia erros do domínio de metas para mensagem amigável ao usuário. Erros
 * nomeados (GoalNotFound) viram texto claro; o resto cai num genérico.
 */
function toErrorMessage(e: unknown): string {
  if (e instanceof GoalNotFound) return "Meta não encontrada.";
  return String(e);
}

/** Lista todas as metas do time, ordenadas por período (desc). */
export async function listMetas(): Promise<Meta[]> {
  return runAsUserAction(async () => {
    const goals = await listAllGoals();
    return goals.map(toMeta);
  });
}

export async function createMeta(input: {
  periodo: string;
  metaValor: number;
  toquesPorDia: number;
}): Promise<ActionState> {
  const parsed = createGoalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const user = await currentUser();
  try {
    await runAsUserAction(async () => {
      requireRole("admin"); // RBAC: configurar metas exige admin+ (fail-closed).
      return createGoal({ ...parsed.data, ownerId: user?.id ?? undefined });
    });
  } catch (e) {
    return { error: toErrorMessage(e) };
  }
  revalidatePath("/configuracoes");
  return { ok: true };
}

export async function updateMeta(input: {
  id: string;
  periodo: string;
  metaValor: number;
  toquesPorDia: number;
}): Promise<ActionState> {
  const parsed = updateGoalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    await runAsUserAction(async () => {
      requireRole("admin"); // RBAC: configurar metas exige admin+ (fail-closed).
      return updateGoal(parsed.data);
    });
  } catch (e) {
    return { error: toErrorMessage(e) };
  }
  revalidatePath("/configuracoes");
  return { ok: true };
}

export async function deleteMeta(input: { id: string }): Promise<ActionState> {
  const parsed = deleteGoalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    await runAsUserAction(async () => {
      requireRole("admin"); // RBAC: configurar metas exige admin+ (fail-closed).
      return deleteGoal(parsed.data.id);
    });
  } catch (e) {
    return { error: toErrorMessage(e) };
  }
  revalidatePath("/configuracoes");
  return { ok: true };
}
