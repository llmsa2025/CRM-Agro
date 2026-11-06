import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Opt-out lido UMA vez no gatilho (sugestão da auditoria do #114): com vários
 * fluxos casados, o contato não é relido a cada fluxo e o log sai uma vez só.
 * Fila mockada: nada é agendado nem enviado.
 */
const fila = vi.hoisted(() => ({ scheduleStep: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => fila.scheduleStep(...a),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));

const { enrollByTrigger } = await import("./triggers");
const { podeReinscrever, MOTIVO_OPT_OUT } = await import("./limites");
const { logger } = await import("../logger/index");

const TEAM = "00000000-0000-0000-0000-0000000001af";

async function limpar() {
  const where = { teamId: TEAM };
  await basePrisma.enrollment.deleteMany({ where });
  await basePrisma.flowNode.deleteMany({ where });
  await basePrisma.flow.deleteMany({ where });
  await basePrisma.contact.deleteMany({ where });
}
beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Time (agente A — opt-out lido 1×)" } });
});
beforeEach(async () => {
  fila.scheduleStep.mockClear();
  await limpar();
  for (let i = 0; i < 3; i++) {
    const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: `F${i}`, triggerType: "contact_created", status: "active" } });
    await basePrisma.flowNode.create({ data: { teamId: TEAM, flowId: flow.id, tipo: "add_tag" as never, config: { tag: "x" } as never } });
  }
});
afterAll(limpar);

describe("enrollByTrigger lê o opt-out uma vez", () => {
  it("3 fluxos casados, contato opt-out: nenhuma inscrição e um log só", async () => {
    const sai = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Sai", relacionamentoStatus: "opt_out" } });
    const info = vi.spyOn(logger, "info");
    await runWithTeam(TEAM, () => enrollByTrigger("contact_created", { contactId: sai.id }));
    const logs = info.mock.calls.filter((c) => JSON.stringify(c).includes(MOTIVO_OPT_OUT));
    info.mockRestore();
    expect(logs).toHaveLength(1);
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM } })).toBe(0);
    expect(fila.scheduleStep).not.toHaveBeenCalled();
  });

  it("contato comum entra nos 3 fluxos", async () => {
    const fica = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Fica" } });
    await runWithTeam(TEAM, () => enrollByTrigger("contact_created", { contactId: fica.id }));
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: fica.id } })).toBe(3);
  });

  it("podeReinscrever usa o status informado (sem reler) e, sem ele, lê do banco", async () => {
    const sai = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Sai", relacionamentoStatus: "opt_out" } });
    const base = { flowId: randomUUID(), triggerType: "contact_created", triggerConfig: {} };
    await runWithTeam(TEAM, async () => {
      // Informado: vale o que veio (id inexistente, então não houve leitura).
      expect(await podeReinscrever({ ...base, contactId: randomUUID(), relacionamentoStatus: "opt_out" })).toEqual({ ok: false, motivo: MOTIVO_OPT_OUT });
      expect(await podeReinscrever({ ...base, contactId: sai.id, relacionamentoStatus: "novo" })).toEqual({ ok: true });
      // Não informado: lê do banco (compatível com quem já chamava).
      expect(await podeReinscrever({ ...base, contactId: sai.id })).toEqual({ ok: false, motivo: MOTIVO_OPT_OUT });
    });
  });
});
