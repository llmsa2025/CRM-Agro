import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * O tipo do fluxo no serviço (criar, atualizar, ativar, inscrever, listar). Fila do motor mockada.
 * O tipo marketing ainda não se cria pela API (TIPOS_DISPONIVEIS), então os fluxos de marketing do teste
 * nascem direto no banco, como nascerão quando o passo "Postagem" existir.
 */
const scheduleStep = vi.fn();
vi.mock("./queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { createFlow, updateFlow, activateFlow, enroll, listFlows } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000000a9";
const DONO = { userId: "dono-tipo", role: "owner" };
const comTime = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, DONO);
let seq = 0;
const id = () => `tp-n${Date.now()}-${seq++}`;
const no = (tipo: string, next: string | null = null) => ({ id: id(), tipo, config: tipo === "wait" ? { duration: 1, unit: "min" } : {}, nextNodeId: next }) as never;

async function fluxoDeMarketing(triggerType: "manual" | "schedule" = "manual") {
  return basePrisma.flow.create({ data: { teamId: TEAM, nome: "Marketing (test)", triggerType, tipo: "marketing", status: "draft" } });
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Tipo do Fluxo (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

describe("criar", () => {
  it("sem tipo, nasce de prospecção (e o que já existia continua assim)", async () => {
    const f = await comTime(() => createFlow({ nome: "P", triggerType: "manual", nodes: [no("send_message")] }));
    expect(f.tipo).toBe("prospeccao");
  });

  it("marketing ainda não se cria: avisa que não está disponível", async () => {
    await expect(comTime(() => createFlow({ nome: "M", tipo: "marketing", triggerType: "manual", nodes: [] }))).rejects.toMatchObject({
      name: "TipoDoFluxoIndisponivel",
    });
  });

  it("prospecção com o passo Postagem é recusada, dizendo onde ela roda", async () => {
    const r = comTime(() => createFlow({ nome: "P", tipo: "prospeccao", triggerType: "manual", nodes: [no("social_post")] }));
    await expect(r).rejects.toMatchObject({ name: "FluxoForaDoTipo" });
    await expect(r).rejects.toThrow(/só roda em fluxo de Marketing/);
  });
});

describe("atualizar", () => {
  it("o tipo não muda depois de criado", async () => {
    const f = await comTime(() => createFlow({ nome: "P", triggerType: "manual", nodes: [no("wait")] }));
    await expect(comTime(() => updateFlow(f.id, { tipo: "marketing" }))).rejects.toMatchObject({ name: "TipoDoFluxoNaoMuda" });
    // reenviar o mesmo tipo (o editor pode mandar) é inofensivo
    await expect(comTime(() => updateFlow(f.id, { tipo: "prospeccao", nome: "P2" }))).resolves.toMatchObject({ nome: "P2" });
  });

  it("fluxo de marketing recusa passo de contato e gatilho de contato", async () => {
    const m = await fluxoDeMarketing();
    await expect(comTime(() => updateFlow(m.id, { nodes: [no("send_message")] }))).rejects.toMatchObject({ name: "FluxoForaDoTipo" });
    await expect(comTime(() => updateFlow(m.id, { triggerType: "message_received" }))).rejects.toMatchObject({ name: "FluxoForaDoTipo" });
    // só o gatilho, sobre passos já salvos, também confere
    await basePrisma.flowNode.create({ data: { id: id(), teamId: TEAM, flowId: m.id, tipo: "wait", config: { duration: 1, unit: "min" } } as never });
    await expect(comTime(() => updateFlow(m.id, { triggerType: "tag_added" }))).rejects.toMatchObject({ name: "FluxoForaDoTipo" });
  });

  it("fluxo de marketing aceita esperar e o gatilho agendado (a Postagem entra com o passo, no próximo PR)", async () => {
    const m = await fluxoDeMarketing();
    const salvo = await comTime(() => updateFlow(m.id, { triggerType: "schedule", nodes: [no("wait"), no("end")] }));
    expect(salvo.nodes.map((n) => n.tipo).sort()).toEqual(["end", "wait"]);
    expect(salvo.triggerType).toBe("schedule");
  });
});

describe("ativar e inscrever", () => {
  it("marketing sem Postagem não ativa", async () => {
    const m = await fluxoDeMarketing();
    await comTime(() => updateFlow(m.id, { nodes: [no("wait")] }));
    await expect(comTime(() => activateFlow(m.id))).rejects.toThrow(/precisa de pelo menos um passo "Postagem"/);
  });

  it("fluxo de marketing não recebe contato (nem pelo Testar nem pelo Trocar de fluxo)", async () => {
    const m = await fluxoDeMarketing();
    await comTime(() => updateFlow(m.id, { nodes: [no("wait")] }));
    await basePrisma.flow.update({ where: { id: m.id }, data: { status: "active" } });
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
    await expect(comTime(() => enroll(c.id, m.id))).rejects.toThrow(/Marketing não recebe contatos/);
    expect(scheduleStep).not.toHaveBeenCalled();
  });
});

describe("listar", () => {
  it("filtra por tipo (campanha e Trocar de fluxo só enxergam prospecção)", async () => {
    await comTime(() => createFlow({ nome: "P", triggerType: "manual", nodes: [no("wait")] }));
    await fluxoDeMarketing();
    const todos = await comTime(() => listFlows({ limit: 50 }));
    const soProspeccao = await comTime(() => listFlows({ limit: 50, tipo: "prospeccao" }));
    const soMarketing = await comTime(() => listFlows({ limit: 50, tipo: "marketing" }));
    expect(todos.items).toHaveLength(2);
    expect(soProspeccao.items.map((f) => f.nome)).toEqual(["P"]);
    expect(soMarketing.items.map((f) => f.nome)).toEqual(["Marketing (test)"]);
  });
});
