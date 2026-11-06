import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Controle operacional do fluxo (item 1.5 — MF-07, MF-09). Fila mockada.
 */
const scheduleStep = vi.fn(async () => {});
const acordarPasso = vi.fn(async () => {});
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => scheduleStep(...(a as [])),
  acordarPasso: (...a: unknown[]) => acordarPasso(...(a as [])),
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { aplicarStatusDoFluxo, encerrarInscricoesDoFluxo, MARCA_FLUXO_PAUSADO } = await import("./controle");
const { activateFlow, pauseFlow } = await import("./service");
const { enrollByTrigger } = await import("./triggers");
const { InvalidGraphError } = await import("./errors");
const { moveDeal } = await import("../funnels/service");

const TEAM = "00000000-0000-0000-0000-0000000000c7";
const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
const uid = (p: string) => `${p}-${sufixo}-${seq++}`;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Controle (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  acordarPasso.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

async function fluxoComInscricoes(n: number, status: "active" | "paused" = "active") {
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: uid("F"), triggerType: "manual", status } });
  const nodeId = uid("n");
  await basePrisma.flowNode.create({ data: { id: nodeId, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never } });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: `C${i}` } });
    const e = await basePrisma.enrollment.create({
      data: { teamId: TEAM, flowId: flow.id, contactId: c.id, currentNodeId: nodeId, currentRound: 1, status: "active", nextRunAt: new Date() },
    });
    ids.push(e.id);
  }
  return { flow, nodeId, ids };
}

describe("pausar para de verdade", () => {
  it("passo de fluxo pausado é SEGURADO no ponto; reativar retoma exatamente dali", async () => {
    const { flow, nodeId, ids } = await fluxoComInscricoes(2);
    await runWithTeam(TEAM, () => pauseFlow(flow.id));
    // O worker pegou o job do passo round 3 de uma das inscrições com o fluxo pausado:
    const d = await runWithTeam(TEAM, () => aplicarStatusDoFluxo({ enrollmentId: ids[0]!, nodeId, round: 3, flowStatus: "paused" }));
    expect(d).toBe("segurado");
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: ids[0]! } })).toMatchObject({
      status: "waiting",
      nextRunAt: null,
      waitingFor: MARCA_FLUXO_PAUSADO,
      currentRound: 3,
    });

    await runWithTeam(TEAM, () => activateFlow(flow.id));
    // acordarPasso: o job do passo já existe como concluído (rodou e segurou);
    // um scheduleStep com o mesmo jobId seria ignorado pelo BullMQ.
    expect(acordarPasso).toHaveBeenCalledWith(ids[0], nodeId, 3);
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: ids[0]! } })).toMatchObject({ status: "active", waitingFor: null });
  });

  it("fluxo arquivado encerra a inscrição quando o passo chega", async () => {
    const { nodeId, ids } = await fluxoComInscricoes(1);
    const d = await runWithTeam(TEAM, () => aplicarStatusDoFluxo({ enrollmentId: ids[0]!, nodeId, round: 1, flowStatus: "archived" }));
    expect(d).toBe("encerrado");
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: ids[0]! } })).status).toBe("done");
  });

  it("fluxo ativo segue normalmente", async () => {
    const { nodeId, ids } = await fluxoComInscricoes(1);
    expect(await runWithTeam(TEAM, () => aplicarStatusDoFluxo({ enrollmentId: ids[0]!, nodeId, round: 1, flowStatus: "active" }))).toBe("seguir");
  });
});

describe("parar tudo", () => {
  it("encerra todas as inscrições em curso do fluxo (e só dele)", async () => {
    const a = await fluxoComInscricoes(3);
    const b = await fluxoComInscricoes(1);
    const r = await runWithTeam(TEAM, () => encerrarInscricoesDoFluxo(a.flow.id));
    expect(r.encerradas).toBe(3);
    expect(await basePrisma.enrollment.count({ where: { flowId: a.flow.id, status: "done" } })).toBe(3);
    expect(await basePrisma.enrollment.count({ where: { flowId: b.flow.id, status: "active" } })).toBe(1);
  });

  it("viewer não pode parar tudo", async () => {
    const a = await fluxoComInscricoes(1);
    await expect(
      runWithTeam(TEAM, () => encerrarInscricoesDoFluxo(a.flow.id), { userId: "v", role: "viewer" }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

describe("gatilho 'mudou de etapa' com filtro (MF-09)", () => {
  async function funilComEtapas() {
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
    const [novo, proposta, perdido] = await Promise.all(
      ["Novo", "Proposta", "Perdido"].map((nome, ordem) =>
        basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome, ordem } }),
      ),
    );
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
    const deal = await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: novo!.id, contactId: c.id, valor: 0 } });
    return { funil, novo: novo!, proposta: proposta!, perdido: perdido!, deal, c };
  }

  it("só a mudança configurada inscreve: 'entrou em Proposta' ignora 'Perdido'", async () => {
    const { funil, proposta, perdido, deal } = await funilComEtapas();
    const flow = await basePrisma.flow.create({
      data: { teamId: TEAM, nome: "Proposta", triggerType: "stage_changed", status: "active", triggerConfig: { funnelId: funil.id, toStageId: proposta.id } as never },
    });
    await basePrisma.flowNode.create({ data: { id: uid("n"), teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never } });

    await runWithTeam(TEAM, () => moveDeal(deal.id, perdido.id));
    expect(await basePrisma.enrollment.count({ where: { flowId: flow.id } })).toBe(0);
    await runWithTeam(TEAM, () => moveDeal(deal.id, proposta.id));
    expect(await basePrisma.enrollment.count({ where: { flowId: flow.id } })).toBe(1);
  });

  it("ativar 'mudou de etapa' sem escolher a etapa é recusado", async () => {
    const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "Sem etapa", triggerType: "stage_changed", status: "draft" } });
    await basePrisma.flowNode.create({ data: { id: uid("n"), teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never } });
    await expect(runWithTeam(TEAM, () => activateFlow(flow.id))).rejects.toBeInstanceOf(InvalidGraphError);
  });

  it("filtro por 'saiu de'", async () => {
    const { novo, proposta, perdido, deal } = await funilComEtapas();
    const flow = await basePrisma.flow.create({
      data: { teamId: TEAM, nome: "Saiu de proposta", triggerType: "stage_changed", status: "active", triggerConfig: { toStageId: perdido.id, fromStageId: proposta.id } as never },
    });
    await basePrisma.flowNode.create({ data: { id: uid("n"), teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never } });
    await runWithTeam(TEAM, () => moveDeal(deal.id, perdido.id)); // saiu de "Novo" → não conta
    expect(await basePrisma.enrollment.count({ where: { flowId: flow.id } })).toBe(0);
    expect(novo.id).toBeTruthy();
    // volta e sai de Proposta para Perdido
    await basePrisma.deal.update({ where: { id: deal.id }, data: { stageId: proposta.id } });
    await runWithTeam(TEAM, () => enrollByTrigger("stage_changed", { contactId: deal.contactId, toStageId: perdido.id, fromStageId: proposta.id }));
    expect(await basePrisma.enrollment.count({ where: { flowId: flow.id } })).toBe(1);
  });
});
