import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TriggerType } from "@prisma/client";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { triggerTypeSchema } from "./schema";

/**
 * Gatilho "Contatos selecionados" (`contacts_selected`): o fluxo só roda nos contatos que a pessoa escolhe, nunca
 * por evento, e é outro gatilho que o Manual (que segue servindo ao "Testar" e à troca de fluxo).
 *
 * A fila é mockada: nada de Redis nem de envio real.
 */
const scheduleStep = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { inscreverContatosSelecionados, listarFluxosParaContatosSelecionados, MAX_CONTATOS_POR_VEZ } = await import("./contatos-selecionados");
const { enrollManyByTrigger } = await import("./triggers");

const TEAM = "00000000-0000-0000-0000-0000000001b1";
const OUTRO_TIME = "00000000-0000-0000-0000-0000000001b2";
const TIMES = [TEAM, OUTRO_TIME];
const DONO = { userId: "dono-selecionados", role: "owner" };
const comTime = <T>(fn: () => Promise<T>, teamId = TEAM, identidade = DONO) => runWithTeam(teamId, fn, identidade);

async function limpar() {
  const where = { teamId: { in: TIMES } };
  await basePrisma.enrollment.deleteMany({ where });
  await basePrisma.flowNode.deleteMany({ where });
  await basePrisma.flow.deleteMany({ where });
  await basePrisma.contact.deleteMany({ where });
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM, "Time selecionados (test)"],
    [OUTRO_TIME, "Outro time selecionados (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(async () => {
  scheduleStep.mockClear();
  await limpar();
});
afterAll(limpar);

async function fluxo(teamId: string, nome: string, opts: { triggerType?: string; status?: string; semNos?: boolean; tipoDoNo?: string } = {}) {
  const flow = await basePrisma.flow.create({
    data: {
      teamId,
      nome,
      triggerType: (opts.triggerType ?? "contacts_selected") as never,
      status: (opts.status ?? "active") as never,
    },
  });
  if (!opts.semNos) {
    await basePrisma.flowNode.create({ data: { teamId, flowId: flow.id, tipo: (opts.tipoDoNo ?? "notify_user") as never, config: {} as never } });
  }
  return flow;
}

async function contatos(teamId: string, n: number) {
  const ids = Array.from({ length: n }, () => randomUUID());
  await basePrisma.contact.createMany({ data: ids.map((id, i) => ({ id, teamId, nome: `C${i}` })) });
  return ids;
}

const inscricoes = (flowId: string) => basePrisma.enrollment.findMany({ where: { flowId }, select: { contactId: true, status: true } });

describe("gatilho Contatos selecionados: o enum", () => {
  it("o zod e o enum do banco têm os mesmos gatilhos", () => {
    expect([...triggerTypeSchema.options].sort()).toEqual(Object.keys(TriggerType).sort());
    expect(triggerTypeSchema.options).toContain("contacts_selected");
  });
});

describe("inscreverContatosSelecionados", () => {
  it("inscreve só os selecionados e agenda o primeiro passo de cada um", async () => {
    const f = await fluxo(TEAM, "selecionados");
    const [a, b, c] = await contatos(TEAM, 3);
    const r = await comTime(() => inscreverContatosSelecionados(f.id, [a!, b!]));
    expect(r).toEqual({ inscritas: 2, ignorados: 0 });
    const feitas = await inscricoes(f.id);
    expect(feitas.map((e) => e.contactId).sort()).toEqual([a!, b!].sort());
    expect(feitas.some((e) => e.contactId === c)).toBe(false);
    expect(scheduleStep).toHaveBeenCalledTimes(2);
  });

  it("ids repetidos contam uma vez", async () => {
    const f = await fluxo(TEAM, "repetidos");
    const [a] = await contatos(TEAM, 1);
    const r = await comTime(() => inscreverContatosSelecionados(f.id, [a!, a!, a!]));
    expect(r).toEqual({ inscritas: 1, ignorados: 0 });
  });

  it("quem já percorre o fluxo e quem pediu para sair ficam de fora e entram em `ignorados`", async () => {
    const f = await fluxo(TEAM, "travas");
    const [novo, jaNoFluxo, optOut] = await contatos(TEAM, 3);
    await basePrisma.enrollment.create({ data: { teamId: TEAM, flowId: f.id, contactId: jaNoFluxo!, currentNodeId: "x", status: "waiting" } });
    await basePrisma.contact.update({ where: { id: optOut! }, data: { relacionamentoStatus: "opt_out" } });
    const r = await comTime(() => inscreverContatosSelecionados(f.id, [novo!, jaNoFluxo!, optOut!]));
    expect(r).toEqual({ inscritas: 1, ignorados: 2 });
    expect((await inscricoes(f.id)).filter((e) => e.contactId === optOut)).toHaveLength(0);
  });

  it("não é o Manual: o gatilho manual não inscreve em fluxo de Contatos selecionados", async () => {
    const f = await fluxo(TEAM, "so-selecionados");
    const ids = await contatos(TEAM, 2);
    const r = await comTime(() => enrollManyByTrigger("manual", ids));
    expect(r.inscritas).toBe(0);
    expect(await inscricoes(f.id)).toHaveLength(0);
  });

  it("recusa fluxo com outro gatilho, fluxo fora do ar e fluxo sem passos", async () => {
    const [a] = await contatos(TEAM, 1);
    const manual = await fluxo(TEAM, "manual", { triggerType: "manual" });
    const pausado = await fluxo(TEAM, "pausado", { status: "paused" });
    const vazio = await fluxo(TEAM, "vazio", { semNos: true });
    await expect(comTime(() => inscreverContatosSelecionados(manual.id, [a!]))).rejects.toThrow(/gatilho deste fluxo não é Contatos selecionados/);
    await expect(comTime(() => inscreverContatosSelecionados(pausado.id, [a!]))).rejects.toMatchObject({ name: "FlowNotActive" });
    await expect(comTime(() => inscreverContatosSelecionados(vazio.id, [a!]))).rejects.toThrow(/fluxo sem nós/);
    expect(scheduleStep).not.toHaveBeenCalled();
  });

  it("recusa fluxo de Marketing (não recebe contato)", async () => {
    const [a] = await contatos(TEAM, 1);
    const f = await fluxo(TEAM, "marketing");
    await basePrisma.flow.update({ where: { id: f.id }, data: { tipo: "marketing" } });
    await expect(comTime(() => inscreverContatosSelecionados(f.id, [a!]))).rejects.toThrow(/Marketing não recebe contatos/);
  });

  it("seleção vazia e seleção grande demais têm erro com frase para a pessoa", async () => {
    const f = await fluxo(TEAM, "limites");
    await expect(comTime(() => inscreverContatosSelecionados(f.id, []))).rejects.toThrow(/selecione ao menos um contato/);
    const demais = Array.from({ length: MAX_CONTATOS_POR_VEZ + 1 }, () => randomUUID());
    await expect(comTime(() => inscreverContatosSelecionados(f.id, demais))).rejects.toMatchObject({ name: "SelecaoGrandeDemais" });
  });

  it("um contato de outro time derruba a chamada inteira (nenhum entra)", async () => {
    const f = await fluxo(TEAM, "dois-times");
    const [meu] = await contatos(TEAM, 1);
    const [alheio] = await contatos(OUTRO_TIME, 1);
    await expect(comTime(() => inscreverContatosSelecionados(f.id, [meu!, alheio!]))).rejects.toMatchObject({ name: "OwnedNotFound" });
    expect(await inscricoes(f.id)).toHaveLength(0);
  });

  it("fluxo de outro time é 'não encontrado'", async () => {
    const alheio = await fluxo(OUTRO_TIME, "do-outro-time");
    const [meu] = await contatos(TEAM, 1);
    await expect(comTime(() => inscreverContatosSelecionados(alheio.id, [meu!]))).rejects.toMatchObject({ name: "FlowNotFound" });
  });

  it("quem só lê (viewer) não roda fluxo", async () => {
    const f = await fluxo(TEAM, "viewer");
    const [a] = await contatos(TEAM, 1);
    await expect(
      comTime(() => inscreverContatosSelecionados(f.id, [a!]), TEAM, { userId: "so-leitura", role: "viewer" }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await inscricoes(f.id)).toHaveLength(0);
  });
});

describe("listarFluxosParaContatosSelecionados", () => {
  it("lista só os fluxos no ar com este gatilho, em ordem de nome", async () => {
    await fluxo(TEAM, "B segundo");
    await fluxo(TEAM, "A primeiro");
    await fluxo(TEAM, "rascunho", { status: "draft" });
    await fluxo(TEAM, "pausado", { status: "paused" });
    await fluxo(TEAM, "manual", { triggerType: "manual" });
    await fluxo(OUTRO_TIME, "de outro time");
    const lista = await comTime(() => listarFluxosParaContatosSelecionados());
    expect(lista.map((f) => f.nome)).toEqual(["A primeiro", "B segundo"]);
  });
});
