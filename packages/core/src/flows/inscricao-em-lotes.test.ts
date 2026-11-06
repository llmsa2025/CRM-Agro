import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Inscrição em massa em lotes pequenos, com freio e paralelismo limitado (incidente de 02/10/2026). Fila FALSA que mede
 * quantos agendamentos estão em voo ao mesmo tempo; o freio é espiado (nada espera de verdade).
 */
const fila = vi.hoisted(() => ({ emVoo: 0, maxEmVoo: 0, agendados: 0 }));
vi.mock("./queue", () => ({
  scheduleStep: async () => {
    fila.emVoo++;
    fila.maxEmVoo = Math.max(fila.maxEmVoo, fila.emVoo);
    await new Promise((r) => setTimeout(r, 2));
    fila.emVoo--;
    fila.agendados++;
  },
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));
const freio = vi.hoisted(() => ({ entreLotes: 0 }));
vi.mock("./pressao", async (original) => {
  const real = await original<typeof import("./pressao")>();
  return { ...real, criarFreioDeInscricao: () => ({ entreLotes: async () => void freio.entreLotes++, esperouAteOFim: () => false }) };
});

const { enrollManyByTrigger } = await import("./triggers");
const { LOTE_INSCRICAO, AGENDAR_EM_PARALELO } = await import("./pressao");

const TEAM = "00000000-0000-0000-0000-0000000e0021";
let flowId = "";

async function limpar() {
  const w = { teamId: TEAM };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowVersion.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team lotes (test)" } });
  await limpar();
  const tag = await basePrisma.tag.create({ data: { teamId: TEAM, nome: "lista" } });
  const f = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "Da lista", triggerType: "tag_added", triggerConfig: { tagId: tag.id }, status: "active" } });
  flowId = f.id;
  await basePrisma.flowNode.create({ data: { teamId: TEAM, flowId, tipo: "wait" as never, config: { duration: 1, unit: "min" } as never, nextNodeId: null } });
});
afterAll(limpar);

describe("inscrição em massa", () => {
  it("muitos contatos entram em lotes de até 100, com o freio entre os lotes e no máximo 25 agendamentos ao mesmo tempo", async () => {
    const ids = Array.from({ length: 1132 }, () => randomUUID());
    await basePrisma.contact.createMany({ data: ids.map((id) => ({ id, teamId: TEAM, nome: "Lead" })) });
    const tagId = (await basePrisma.tag.findFirstOrThrow({ where: { teamId: TEAM } })).id;

    const r = await runWithTeam(TEAM, () => enrollManyByTrigger("tag_added", ids, { tagId }, { soFluxoId: flowId }));

    expect(r.inscritas).toBe(1132);
    expect(await basePrisma.enrollment.count({ where: { flowId } })).toBe(1132);
    expect(fila.agendados).toBe(1132);
    expect(fila.maxEmVoo).toBeLessThanOrEqual(AGENDAR_EM_PARALELO);
    expect(fila.maxEmVoo).toBeGreaterThan(1); // paralelo de verdade, não um a um
    // 1.132 / 100 = 12 lotes: o freio roda entre eles (11 vezes).
    expect(freio.entreLotes).toBe(Math.ceil(1132 / LOTE_INSCRICAO) - 1);
  }, 120_000);

  it("rodar de novo não inscreve ninguém em dobro", async () => {
    const ids = (await basePrisma.enrollment.findMany({ where: { flowId }, select: { contactId: true }, take: 250 })).map((e) => e.contactId);
    const tagId = (await basePrisma.tag.findFirstOrThrow({ where: { teamId: TEAM } })).id;
    const r = await runWithTeam(TEAM, () => enrollManyByTrigger("tag_added", ids, { tagId }, { soFluxoId: flowId }));
    expect(r.inscritas).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { flowId } })).toBe(1132);
  });
});
