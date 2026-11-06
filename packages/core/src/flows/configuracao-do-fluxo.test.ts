import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/** Menu ⋯ da lista de fluxos: editar nome e horário (sem mexer nos passos) e excluir. Fila do motor mockada. */
vi.mock("./queue", () => ({
  scheduleStep: vi.fn(),
  acordarPasso: vi.fn(),
  flowJobId: (a: string, b: string, c: number) => `${a}:${b}:${c}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { createFlow, updateFlowSettings, deleteFlow, activateFlow, enroll, getFlow } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000000ac";
const OUTRO = "00000000-0000-0000-0000-0000000000ad";
const DONO = { userId: "dono-menu", role: "owner" };
const comTime = <T>(fn: () => Promise<T>, time = TEAM) => runWithTeam(time, fn, DONO);
let seq = 0;
const noUnico = () => [{ id: `cf-n${Date.now()}-${seq++}`, tipo: "wait", config: { duration: 1, unit: "min" }, nextNodeId: null }] as never;

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team menu do fluxo (${id.slice(-2)})` } });
});

beforeEach(async () => {
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowVersion.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

describe("editar nome e horário", () => {
  it("troca o nome e o horário sem tocar nos passos nem nas outras chaves do gatilho", async () => {
    const f = await comTime(() =>
      createFlow({ nome: "Antigo", triggerType: "manual", triggerConfig: { reentry: "never", exclusivo: true, jitterMin: 2, jitterMax: 5 }, nodes: noUnico() }),
    );
    const janela = { modo: "propria", abertura: "09:00", fechamento: "17:30", dias: ["mon", "tue", "wed"], feriados: true };
    const r = await comTime(() => updateFlowSettings(f.id, { nome: "  Novo nome  ", janelaEnvio: janela }));
    expect(r.nome).toBe("Novo nome");
    expect(r.triggerConfig).toEqual({ reentry: "never", exclusivo: true, jitterMin: 2, jitterMax: 5, janelaEnvio: janela });
    expect((await comTime(() => getFlow(f.id))).nodes).toHaveLength(1);
  });

  it("só o nome: o gatilho fica igual", async () => {
    const f = await comTime(() => createFlow({ nome: "A", triggerType: "manual", triggerConfig: { reentry: "always" }, nodes: noUnico() }));
    const r = await comTime(() => updateFlowSettings(f.id, { nome: "B" }));
    expect(r).toMatchObject({ nome: "B", triggerConfig: { reentry: "always" } });
  });

  it("recusa nome vazio e horário torto (fechamento antes da abertura, nenhum dia)", async () => {
    const f = await comTime(() => createFlow({ nome: "A", triggerType: "manual", nodes: noUnico() }));
    await expect(comTime(() => updateFlowSettings(f.id, { nome: "   " }))).rejects.toThrow(/nome do fluxo/);
    await expect(
      comTime(() => updateFlowSettings(f.id, { janelaEnvio: { modo: "propria", abertura: "18:00", fechamento: "08:00", dias: ["mon"], feriados: false } })),
    ).rejects.toMatchObject({ name: "JanelaDeEnvioInvalida" });
    await expect(
      comTime(() => updateFlowSettings(f.id, { janelaEnvio: { modo: "propria", abertura: "08:00", fechamento: "18:00", dias: [], feriados: false } })),
    ).rejects.toMatchObject({ name: "JanelaDeEnvioInvalida" });
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } })).nome).toBe("A");
  });

  it("fluxo de outro time não existe para quem edita", async () => {
    const dele = await comTime(() => createFlow({ nome: "Dele", triggerType: "manual", nodes: noUnico() }), OUTRO);
    await expect(comTime(() => updateFlowSettings(dele.id, { nome: "Meu agora" }))).rejects.toMatchObject({ name: "FlowNotFound" });
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: dele.id } })).nome).toBe("Dele");
  });
});

describe("excluir", () => {
  it("exclui o fluxo com passos, versões e inscrições, e diz quantas estavam em andamento", async () => {
    const f = await comTime(() => createFlow({ nome: "Para excluir", triggerType: "manual", nodes: noUnico() }));
    await comTime(() => activateFlow(f.id));
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
    await comTime(() => enroll(c.id, f.id));
    expect(await basePrisma.enrollment.count({ where: { flowId: f.id } })).toBe(1);

    const r = await comTime(() => deleteFlow(f.id));
    expect(r.inscricoesEmAndamento).toBe(1);
    expect(await basePrisma.flow.count({ where: { id: f.id } })).toBe(0);
    expect(await basePrisma.flowNode.count({ where: { flowId: f.id } })).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { flowId: f.id } })).toBe(0);
    expect(await basePrisma.flowVersion.count({ where: { flowId: f.id } })).toBe(0);
    expect(await basePrisma.contact.count({ where: { id: c.id } })).toBe(1); // o contato continua
  });

  it("não exclui fluxo de outro time", async () => {
    const dele = await comTime(() => createFlow({ nome: "Dele", triggerType: "manual", nodes: noUnico() }), OUTRO);
    await expect(comTime(() => deleteFlow(dele.id))).rejects.toMatchObject({ name: "FlowNotFound" });
    expect(await basePrisma.flow.count({ where: { id: dele.id } })).toBe(1);
  });
});
