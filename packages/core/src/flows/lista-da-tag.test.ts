import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/** Fluxo de tag: ao ATIVAR e ao SALVAR no ar, entra quem já tem a tag e ainda não rodou. Fila mockada; contatos descartáveis. */
vi.mock("./queue", () => ({
  scheduleStep: vi.fn(async () => {}),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { inscreverQuemJaTemATag } = await import("./lista-da-tag");
const { activateFlow, updateFlow } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000000d7";
let tagId = "";
let flowId = "";
let ids: Record<"a" | "b" | "c" | "d", string>;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team lista da tag" } });
});

const limpar = async () => {
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowVersion.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
};

async function fluxo(status: "active" | "paused" | "draft", nome = "F", tipo: "prospeccao" | "enriquecimento" = "prospeccao") {
  const f = await basePrisma.flow.create({ data: { teamId: TEAM, nome, tipo, triggerType: "tag_added", triggerConfig: { tagId }, status } });
  await basePrisma.flowNode.create({ data: { teamId: TEAM, flowId: f.id, tipo: "wait" as never, config: { duration: 1, unit: "min" } as never, nextNodeId: null } });
  return f.id;
}

beforeEach(async () => {
  await limpar();
  tagId = (await basePrisma.tag.create({ data: { teamId: TEAM, nome: "lista" } })).id;
  const mk = async (nome: string, extra: object = {}) => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome, ...extra } });
    await basePrisma.contactTag.create({ data: { teamId: TEAM, contactId: c.id, tagId } });
    return c.id;
  };
  ids = { a: await mk("A"), b: await mk("B"), c: await mk("C"), d: await mk("D", { relacionamentoStatus: "opt_out" }) };
  flowId = await fluxo("active");
  // C já rodou este fluxo (concluída): não repete.
  await basePrisma.enrollment.create({ data: { teamId: TEAM, flowId, contactId: ids.c, currentNodeId: "x", currentRound: 1, status: "done" } });
});
afterAll(limpar);

const inscricoes = (contactId: string, fid = flowId) => basePrisma.enrollment.count({ where: { flowId: fid, contactId } });

describe("quem já tem a tag entra no fluxo", () => {
  it("entra quem nunca rodou; quem já rodou e quem pediu para sair ficam de fora; rodar de novo não repete", async () => {
    const r = await runWithTeam(TEAM, () => inscreverQuemJaTemATag(flowId));
    expect(r).toEqual({ inscritas: 2 });
    expect([await inscricoes(ids.a), await inscricoes(ids.b), await inscricoes(ids.c), await inscricoes(ids.d)]).toEqual([1, 1, 1, 0]);
    expect(await runWithTeam(TEAM, () => inscreverQuemJaTemATag(flowId))).toEqual({ inscritas: 0 });
    expect(await basePrisma.enrollment.count({ where: { flowId } })).toBe(3);
  });

  it("só o fluxo ativado é tocado: outro fluxo ativo com a mesma tag não recebe ninguém", async () => {
    const outro = await fluxo("active", "Outro");
    await runWithTeam(TEAM, () => inscreverQuemJaTemATag(flowId));
    expect(await basePrisma.enrollment.count({ where: { flowId: outro } })).toBe(0);
  });

  it("fluxo desativado (pausado ou rascunho) não roda nada", async () => {
    for (const status of ["paused", "draft"] as const) {
      const f = await fluxo(status, status);
      expect(await runWithTeam(TEAM, () => inscreverQuemJaTemATag(f))).toEqual({ inscritas: 0 });
      expect(await basePrisma.enrollment.count({ where: { flowId: f } })).toBe(0);
    }
  });

  it("depois de ativar, ele roda: ativar devolve quantos entraram", async () => {
    const f = await fluxo("paused", "Para ativar", "enriquecimento");
    const ativado = await runWithTeam(TEAM, () => activateFlow(f));
    expect(ativado.inscritas).toBe(3); // A, B e C (C nunca rodou ESTE fluxo); D pediu para sair
    expect(await basePrisma.enrollment.count({ where: { flowId: f } })).toBe(3);
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: f } })).status).toBe("active");
  });

  it("salvar um fluxo que já está no ar também roda; salvar um desativado só salva", async () => {
    const noAr = await runWithTeam(TEAM, () => updateFlow(flowId, { triggerType: "tag_added", triggerConfig: { tagId } }));
    expect((noAr as { inscritas?: number }).inscritas).toBe(2);
    const parado = await fluxo("paused", "Parado");
    const salvo = await runWithTeam(TEAM, () => updateFlow(parado, { triggerType: "tag_added", triggerConfig: { tagId } }));
    expect((salvo as { inscritas?: number }).inscritas).toBeUndefined();
    expect(await basePrisma.enrollment.count({ where: { flowId: parado } })).toBe(0);
  });
});
