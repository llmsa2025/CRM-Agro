import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Andamento do fluxo por estado e botão "Retomar as seguradas" (incidente de 02/10/2026). Fila FALSA: nada roda.
 */
const fila = vi.hoisted(() => ({ acordados: [] as string[] }));
vi.mock("./queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async (e: string) => void fila.acordados.push(e),
  removeStepJob: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
}));

const { andamentoDoFluxo, retomarSeguradasDoFluxo } = await import("./andamento");
const { listReviewEnrollments } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000e0031";
const DONO = { userId: "dono-andamento", role: "owner" };
const MEMBRO = { userId: "membro-andamento", role: "member" };
const N1 = "an-n1";
const HORA = 3_600_000;
let flowId = "";

async function limpar() {
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team andamento (test)" } });
});
afterAll(limpar);

/** `n` inscrições do fluxo com os dados dados (um contato novo para cada). */
async function inscricoes(n: number, dados: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const contatos = Array.from({ length: n }, () => ({ id: randomUUID(), teamId: TEAM, nome: "Lead" }));
  await basePrisma.contact.createMany({ data: contatos });
  await basePrisma.enrollment.createMany({
    data: contatos.map((c) => ({ teamId: TEAM, flowId, contactId: c.id, currentNodeId: N1, currentRound: 1, ...dados, ...extra })) as never,
  });
}

beforeEach(async () => {
  fila.acordados.length = 0;
  await limpar();
  flowId = (await basePrisma.flow.create({ data: { teamId: TEAM, nome: "Andamento", triggerType: "manual", status: "active" } })).id;
  await basePrisma.flowNode.create({ data: { teamId: TEAM, flowId, id: N1, tipo: "wait" as never, config: { duration: 1, unit: "min" } as never, nextNodeId: null } });
  const depois = new Date(Date.now() + HORA);
  await inscricoes(3, { status: "active", nextRunAt: new Date() });
  await inscricoes(4, { status: "waiting", nextRunAt: depois });
  await inscricoes(2, { status: "waiting", nextRunAt: depois, waitingFor: "reply", waitingUntil: depois });
  await inscricoes(1, { status: "waiting", nextRunAt: depois, waitingFor: "social" });
  await inscricoes(5, { status: "waiting", nextRunAt: null, waitingFor: "fluxo_pausado" });
  await inscricoes(2, { status: "waiting", nextRunAt: null }); // segurada para revisão
  await inscricoes(6, { status: "done", nextRunAt: null });
  await inscricoes(2, { status: "failed", nextRunAt: null });
  // Um ramo paralelo não conta como pessoa.
  const pai = await basePrisma.enrollment.findFirstOrThrow({ where: { flowId, status: "active" } });
  await inscricoes(1, { status: "active", nextRunAt: new Date() }, { paiId: pai.id });
});

describe("andamento por estado", () => {
  it("cada inscrição cai em um estado só, com a contagem; ramo não conta", async () => {
    const a = await runWithTeam(TEAM, () => andamentoDoFluxo(flowId), DONO);
    expect(a).toEqual({
      fluxoStatus: "active",
      total: 25,
      executando: 3,
      aguardando: 4,
      aguardandoResposta: 2,
      naFilaSocial: 1,
      seguradasPelaPausa: 5,
      seguradasParaRevisao: 2,
      concluidas: 6,
      falhas: 2,
    });
    expect(a.executando + a.aguardando + a.aguardandoResposta + a.naFilaSocial + a.seguradasPelaPausa + a.seguradasParaRevisao + a.concluidas + a.falhas).toBe(a.total);
  });

  it("fluxo pausado mostra o status; fluxo de outro time não aparece", async () => {
    await basePrisma.flow.update({ where: { id: flowId }, data: { status: "paused" } });
    expect((await runWithTeam(TEAM, () => andamentoDoFluxo(flowId), DONO)).fluxoStatus).toBe("paused");
    await basePrisma.team.upsert({ where: { id: "00000000-0000-0000-0000-0000000e0032" }, update: {}, create: { id: "00000000-0000-0000-0000-0000000e0032", name: "Outro (test)" } });
    await expect(runWithTeam("00000000-0000-0000-0000-0000000e0032", () => andamentoDoFluxo(flowId), DONO)).rejects.toThrow(/FlowNotFound/);
  });

  it("a aba Histórico (revisar) não enche de gente que só está parada pela pausa", async () => {
    const r = await runWithTeam(TEAM, () => listReviewEnrollments(flowId), DONO);
    expect(r).toHaveLength(4); // 2 seguradas para revisão + 2 falhas; as 5 da pausa ficam de fora
    expect(r.filter((x) => x.status === "waiting")).toHaveLength(2);
  });
});

describe("retomar as seguradas", () => {
  it("só quem pode ativar (administrador): membro é recusado e nada muda", async () => {
    await expect(runWithTeam(TEAM, () => retomarSeguradasDoFluxo(flowId), MEMBRO)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect((await runWithTeam(TEAM, () => andamentoDoFluxo(flowId), DONO)).seguradasPelaPausa).toBe(5);
  });

  it("fluxo pausado: pede para ativar antes (as seguradas só voltam com o fluxo no ar)", async () => {
    await basePrisma.flow.update({ where: { id: flowId }, data: { status: "paused" } });
    await expect(runWithTeam(TEAM, () => retomarSeguradasDoFluxo(flowId), DONO)).rejects.toThrow(/FlowNotActive/);
    expect((await runWithTeam(TEAM, () => andamentoDoFluxo(flowId), DONO)).seguradasPelaPausa).toBe(5);
  });

  it("fluxo no ar: as 5 voltam ao passo em que pararam, uma vez cada; repetir não faz nada", async () => {
    const r = await runWithTeam(TEAM, () => retomarSeguradasDoFluxo(flowId), DONO);
    expect(r).toEqual({ retomadas: 5 });
    expect(fila.acordados).toHaveLength(5);
    const a = await runWithTeam(TEAM, () => andamentoDoFluxo(flowId), DONO);
    expect(a).toMatchObject({ seguradasPelaPausa: 0, executando: 8, total: 25 });
    expect(await runWithTeam(TEAM, () => retomarSeguradasDoFluxo(flowId), DONO)).toEqual({ retomadas: 0 });
  });
});
