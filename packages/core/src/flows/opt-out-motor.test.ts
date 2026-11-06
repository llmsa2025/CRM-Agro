import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Opt-out (N12) no motor: quem pediu para sair não entra em fluxo nenhum (tag,
 * lote, "Testar") e a inscrição que já rodava não manda a próxima mensagem.
 * Fila e canal mockados: nada é enviado.
 */
const fila = vi.hoisted(() => ({ scheduleStep: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => fila.scheduleStep(...a),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));
const canal = vi.hoisted(() => ({ send: vi.fn(async () => ({ providerMessageId: "x" })) }));
vi.mock("@crmagro/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => ({ send: canal.send }),
}));

const { enrollByTrigger, enrollManyByTrigger } = await import("./triggers");
const { enroll } = await import("./service");
const { executeNode } = await import("./executor");
const { MOTIVO_OPT_OUT } = await import("./limites");

const TEAM = "00000000-0000-0000-0000-0000000000d3";
const sufixo = Math.random().toString(36).slice(2, 8);
let flowId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Opt-out Motor (test)" } });
});

beforeEach(async () => {
  fila.scheduleStep.mockClear();
  canal.send.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: `F-${sufixo}`, triggerType: "contact_created", status: "active" } });
  flowId = flow.id;
  await basePrisma.flowNode.create({ data: { id: `n-${sufixo}`, teamId: TEAM, flowId, tipo: "add_tag" as never, config: { tag: "x" } as never } });
});

const contato = (status: "novo" | "opt_out") =>
  basePrisma.contact.create({ data: { teamId: TEAM, nome: `C-${status}`, relacionamentoStatus: status } });

describe("opt-out barra a entrada em fluxo", () => {
  it("gatilho (1 a 1): quem pediu para sair não é inscrito; o outro é", async () => {
    const sai = await contato("opt_out");
    const fica = await contato("novo");
    await runWithTeam(TEAM, () => enrollByTrigger("contact_created", { contactId: sai.id }));
    await runWithTeam(TEAM, () => enrollByTrigger("contact_created", { contactId: fica.id }));
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: sai.id } })).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: fica.id } })).toBe(1);
  });

  it("gatilho em LOTE (importação/tag em massa): opt-out fica de fora", async () => {
    const sai = await contato("opt_out");
    const fica = await contato("novo");
    await runWithTeam(TEAM, () => enrollManyByTrigger("contact_created", [sai.id, fica.id]));
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: sai.id } })).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: fica.id } })).toBe(1);
  });

  it("'Testar' (inscrição manual) de quem pediu para sair é recusado com o motivo", async () => {
    const sai = await contato("opt_out");
    await expect(runWithTeam(TEAM, () => enroll(sai.id, flowId))).rejects.toMatchObject({ name: "InvalidGraphError", message: expect.stringContaining("opt-out") });
  });
});

describe("opt-out na hora de enviar", () => {
  it("inscrição que já rodava termina no passo de envio, sem chamar o canal", async () => {
    const node = { id: "msg", tipo: "send_message", config: { text: "Oi" }, nextNodeId: "fim" } as never;
    const r = await runWithTeam(TEAM, () =>
      executeNode(
        { id: "e", teamId: TEAM, contactId: "c", lastOutboundAt: null, contact: { id: "c", nome: "X", tags: [], ownerId: null, relacionamentoStatus: "opt_out" } },
        node,
      ),
    );
    expect(r).toEqual({ nextNodeId: null, skipped: true, motivo: MOTIVO_OPT_OUT });
    expect(canal.send).not.toHaveBeenCalled();
  });
});
