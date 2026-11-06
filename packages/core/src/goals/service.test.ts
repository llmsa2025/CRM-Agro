import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import {
  createGoal,
  listAllGoals,
  listGoals,
  getGoalById,
  updateGoal,
  deleteGoal,
  GoalNotFound,
} from "./index";

// Times de teste (hex válido). DEV_TEAM_ID (000...001) é do seed — usamos outros.
const TEAM_A = "00000000-0000-0000-0000-0000000000a1";
const TEAM_B = "00000000-0000-0000-0000-0000000000b2";

beforeAll(async () => {
  // Cria os dois times de teste (basePrisma escapa da tenancy).
  for (const [id, name] of [
    [TEAM_A, "Team A (goals test)"],
    [TEAM_B, "Team B (goals test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  // Limpa as metas de ambos os times entre testes (basePrisma ignora tenancy).
  await basePrisma.goal.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
});

describe("goals service (tenant-scoped)", () => {
  it("cria e lista metas do próprio time", async () => {
    await runWithTeam(TEAM_A, async () => {
      await createGoal({ periodo: "2026-07", metaValor: 10000, toquesPorDia: 20 });
      const metas = await listAllGoals();
      expect(metas.length).toBe(1);
      expect(metas[0]?.periodo).toBe("2026-07");
      expect(Number(metas[0]?.metaValor)).toBe(10000);
      expect(metas[0]?.toquesPorDia).toBe(20);
    });
  });

  it("isola metas entre times (fail-closed)", async () => {
    await runWithTeam(TEAM_A, async () => {
      await createGoal({ periodo: "2026-08", metaValor: 5000, toquesPorDia: 10 });
    });
    // Time B não enxerga a meta do time A.
    await runWithTeam(TEAM_B, async () => {
      const metas = await listAllGoals();
      expect(metas.length).toBe(0);
    });
  });

  it("ordena por período desc e pagina com listGoals", async () => {
    await runWithTeam(TEAM_A, async () => {
      await createGoal({ periodo: "2026-06", metaValor: 1, toquesPorDia: 1 });
      await createGoal({ periodo: "2026-08", metaValor: 2, toquesPorDia: 2 });
      await createGoal({ periodo: "2026-07", metaValor: 3, toquesPorDia: 3 });
      const all = await listAllGoals();
      expect(all.map((g) => g.periodo)).toEqual(["2026-08", "2026-07", "2026-06"]);
      const page = await listGoals({ limit: 2 });
      expect(page.items.length).toBe(2);
      expect(page.hasMore).toBe(true);
    });
  });

  it("atualiza uma meta do time", async () => {
    await runWithTeam(TEAM_A, async () => {
      const created = await createGoal({ periodo: "2026-09", metaValor: 100, toquesPorDia: 5 });
      const updated = await updateGoal({
        id: created.id,
        periodo: "2026-09",
        metaValor: 250,
        toquesPorDia: 8,
      });
      expect(Number(updated.metaValor)).toBe(250);
      expect(updated.toquesPorDia).toBe(8);
      const reread = await getGoalById(created.id);
      expect(Number(reread.metaValor)).toBe(250);
    });
  });

  it("remove uma meta do time", async () => {
    await runWithTeam(TEAM_A, async () => {
      const created = await createGoal({ periodo: "2026-10", metaValor: 1, toquesPorDia: 1 });
      await deleteGoal(created.id);
      const metas = await listAllGoals();
      expect(metas.length).toBe(0);
    });
  });

  it("lança GoalNotFound ao acessar meta de outro time (escopo)", async () => {
    // Meta criada no time A...
    let goalId = "";
    await runWithTeam(TEAM_A, async () => {
      const g = await createGoal({ periodo: "2026-11", metaValor: 1, toquesPorDia: 1 });
      goalId = g.id;
    });
    // ...não é acessível/atualizável/removível pelo time B.
    await runWithTeam(TEAM_B, async () => {
      await expect(getGoalById(goalId)).rejects.toBeInstanceOf(GoalNotFound);
      await expect(
        updateGoal({ id: goalId, periodo: "2026-11", metaValor: 9, toquesPorDia: 9 }),
      ).rejects.toBeInstanceOf(GoalNotFound);
      await expect(deleteGoal(goalId)).rejects.toBeInstanceOf(GoalNotFound);
    });
  });
});
