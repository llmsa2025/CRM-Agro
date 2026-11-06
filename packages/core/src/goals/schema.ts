import { z } from "zod";

/**
 * Schemas zod de Meta (Goal) — uma fonte de verdade. Tipos via z.infer.
 * A metodologia comercial (§8 do AGENTS.md) vira config: meta de valor por
 * período + toques/dia. O período é textual "YYYY-MM" (ex.: "2026-07").
 */

/** Período no formato "YYYY-MM" (ano-mês). */
const periodoField = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'periodo deve ser "YYYY-MM" (ex.: "2026-07")');

export const createGoalSchema = z.object({
  periodo: periodoField,
  metaValor: z.number().nonnegative("metaValor não pode ser negativo"),
  toquesPorDia: z.number().int().min(0).default(0),
  ownerId: z.string().uuid("ownerId deve ser um UUID").optional(),
});
export type CreateGoalInput = z.infer<typeof createGoalSchema>;

/**
 * Update de meta: mesmos campos de negócio + `id`. `ownerId` NÃO faz parte do
 * update (o dono da meta não muda na edição — só valor/período/toques).
 */
export const updateGoalSchema = z.object({
  id: z.string().min(1, "id obrigatório"),
  periodo: periodoField,
  metaValor: z.number().nonnegative("metaValor não pode ser negativo"),
  toquesPorDia: z.number().int().min(0),
});
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

/** Delete de meta: só o `id`. */
export const deleteGoalSchema = z.object({
  id: z.string().min(1, "id obrigatório"),
});
export type DeleteGoalInput = z.infer<typeof deleteGoalSchema>;
