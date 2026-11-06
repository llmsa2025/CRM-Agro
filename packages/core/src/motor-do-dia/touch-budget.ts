import { db } from "@crmagro/db";
import { DEFAULT_TZ, zonedParts, zonedTimeToUtc } from "./tz";
import { whereContatoAbordado, whereToqueDeSaida } from "./toque";

/**
 * Orçamento de toques do dia e priorização de contatos — a metodologia comercial
 * virada em número (AGENTS.md §8). Puros (só @crmagro/db). Chamam `db()` no início
 * (leitura eager do teamId via ALS); nunca recebem teamId por parâmetro. Logo,
 * rodam DENTRO de `runWithTeam`/`runAsDev`.
 */

export type Priority = "alta" | "media" | "baixa";

export interface TouchBudget {
  meta: number; // toques-alvo do dia (Goal.toquesPorDia do período atual)
  feitos: number; // toques de saída com prova feitos hoje (ligação só se o provedor comprovou)
  restantes: number; // max(0, meta − feitos)
  progresso: number; // 0–100 (percentual, limitado a 100)
}

/** Período corrente no formato "YYYY-MM" no fuso do usuário (casa com Goal.periodo). */
export function currentPeriodo(timeZone: string = DEFAULT_TZ): string {
  const { year, month } = zonedParts(new Date(), timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Instante UTC do início do dia de hoje no fuso do usuário. */
function startOfTodayUtc(timeZone: string): Date {
  const { year, month, day } = zonedParts(new Date(), timeZone);
  return zonedTimeToUtc(year, month, day, 0, 0, timeZone);
}

/**
 * Orçamento de toques do dia: meta diária (Goal do período atual) vs. toques já
 * feitos hoje. Sem meta cadastrada → meta 0 e progresso 0.
 *
 * "Feito" é o placar (`whereToqueDeSaida`, F1A-03): só saída, e ligação só com a
 * prova do provedor. Ligação declarada, anotação e mensagem recebida não contam.
 */
export async function calcRemainingTouches(timeZone: string = DEFAULT_TZ): Promise<TouchBudget> {
  const prisma = db();
  const periodo = currentPeriodo(timeZone);
  const todayStart = startOfTodayUtc(timeZone);

  const [goal, feitos] = await Promise.all([
    prisma.goal.findFirst({ where: { periodo }, orderBy: { createdAt: "desc" } }),
    prisma.activity.count({
      where: { AND: [whereToqueDeSaida(), { createdAt: { gte: todayStart } }] },
    }),
  ]);

  const meta = goal?.toquesPorDia ?? 0;
  const restantes = Math.max(0, meta - feitos);
  const progresso = meta > 0 ? Math.min(100, Math.round((feitos / meta) * 100)) : 0;

  return { meta, feitos, restantes, progresso };
}

/**
 * Prioridade de um contato pela idade da última abordagem nossa (é lista do dia,
 * não placar: `whereContatoAbordado` aceita a ligação declarada e a anotada):
 * - sem nenhum toque → alta
 * - último toque há mais de 3 dias → alta
 * - último toque de 1 a 3 dias → média
 * - último toque hoje (menos de 1 dia) → baixa
 *
 * A idade é medida em dias inteiros decorridos (floor de ms/dia).
 */
export async function calcPriority(contactId: string): Promise<Priority> {
  const prisma = db();
  const last = await prisma.activity.findFirst({
    where: { AND: [{ contactId }, whereContatoAbordado()] },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (!last) return "alta";

  const days = Math.floor((Date.now() - last.createdAt.getTime()) / 86_400_000);
  if (days > 3) return "alta";
  if (days >= 1) return "media";
  return "baixa";
}
