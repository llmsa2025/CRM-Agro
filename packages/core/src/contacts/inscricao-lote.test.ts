import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Inscrição EM LOTE (MF-13): `enrollManyByTrigger` tem de inscrever EXATAMENTE
 * quem o caminho unitário (`enrollByTrigger` contato a contato) inscreveria, com
 * as mesmas travas (filtro do gatilho, em curso, reentrada, exclusividade,
 * profundidade, snapshot), e é o que a importação e a tag em massa usam agora.
 *
 * A fila é mockada: nada de Redis nem de envio real.
 */
const scheduleStep = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { enrollByTrigger, enrollManyByTrigger } = await import("../flows/triggers");
const contacts = await import("./service");
const tags = await import("../tags/service");

// Um time roda o caminho unitário e o outro o lote, sobre o MESMO cenário.
const TEAM_UNI = "00000000-0000-0000-0000-0000000001a5";
const TEAM_LOTE = "00000000-0000-0000-0000-0000000001a6";
const TIMES = [TEAM_UNI, TEAM_LOTE];

async function limpar() {
  const where = { teamId: { in: TIMES } };
  await basePrisma.enrollment.deleteMany({ where });
  await basePrisma.flowNode.deleteMany({ where });
  await basePrisma.flow.deleteMany({ where });
  await basePrisma.conversation.deleteMany({ where });
  await basePrisma.contactTag.deleteMany({ where });
  await basePrisma.tag.deleteMany({ where });
  await basePrisma.channelIdentifier.deleteMany({ where });
  await basePrisma.activity.deleteMany({ where });
  await basePrisma.contact.deleteMany({ where });
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_UNI, "Time unitário (agente A — lote)"],
    [TEAM_LOTE, "Time lote (agente A — lote)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(async () => {
  scheduleStep.mockClear();
  await limpar();
});
afterAll(limpar);

async function fluxo(
  teamId: string,
  nome: string,
  opts: { triggerType?: string; status?: string; triggerConfig?: object; semNos?: boolean } = {},
) {
  const flow = await basePrisma.flow.create({
    data: {
      teamId,
      nome,
      triggerType: (opts.triggerType ?? "contact_created") as never,
      status: (opts.status ?? "active") as never,
      triggerConfig: (opts.triggerConfig ?? {}) as never,
    },
  });
  if (!opts.semNos) {
    const [a, b] = [randomUUID(), randomUUID()];
    // Criado primeiro o B: o início vem do grafo (quem ninguém aponta), não da ordem.
    await basePrisma.flowNode.create({ data: { id: b, teamId, flowId: flow.id, tipo: "notify_user" as never, config: {} as never } });
    await basePrisma.flowNode.create({ data: { id: a, teamId, flowId: flow.id, tipo: "notify_user" as never, config: {} as never, nextNodeId: b } });
  }
  return flow;
}

/**
 * Cenário com todas as travas: em curso, reentrada "never", cooldown, exclusivo,
 * pausado, sem nós, outro gatilho. Devolve os ids dos contatos em ordem.
 */
async function montarCenario(teamId: string) {
  const ids = Array.from({ length: 8 }, () => randomUUID());
  await basePrisma.contact.createMany({ data: ids.map((id, i) => ({ id, teamId, nome: `C${i}` })) });
  const simples = await fluxo(teamId, "simples");
  const nunca = await fluxo(teamId, "nunca", { triggerConfig: { reentry: "never" } });
  const cooldown = await fluxo(teamId, "cooldown", { triggerConfig: { reentry: { cooldownHours: 24 } } });
  await fluxo(teamId, "exclusivo", { triggerConfig: { exclusivo: true } });
  const outroExclusivo = await fluxo(teamId, "outro-exclusivo", { triggerType: "manual", triggerConfig: { exclusivo: true } });
  await fluxo(teamId, "pausado", { status: "paused" });
  await fluxo(teamId, "vazio", { semNos: true });
  await fluxo(teamId, "de-tag", { triggerType: "tag_added", triggerConfig: { tagId: randomUUID() } });

  const hora = 3_600_000;
  const enr = (flowId: string, contactId: string, status: string, idadeMs: number) => ({
    teamId, flowId, contactId, currentNodeId: "x", status: status as never, createdAt: new Date(Date.now() - idadeMs),
  });
  await basePrisma.enrollment.createMany({
    data: [
      enr(simples.id, ids[0]!, "active", hora), // já no fluxo → pula
      enr(nunca.id, ids[1]!, "done", 90 * 24 * hora), // reentrada "never" → pula
      enr(cooldown.id, ids[2]!, "done", hora), // dentro do cooldown → pula
      enr(cooldown.id, ids[3]!, "done", 48 * hora), // fora do cooldown → entra
      enr(outroExclusivo.id, ids[4]!, "waiting", hora), // em outro exclusivo → pula o exclusivo
    ],
  });
  return ids;
}

/** Inscrições criadas pelo gatilho (as do cenário têm currentNodeId "x"), comparáveis entre times. */
async function inscricoesNovas(teamId: string) {
  const rows = await basePrisma.enrollment.findMany({
    where: { teamId, currentNodeId: { not: "x" } },
    select: {
      flow: { select: { nome: true } },
      contact: { select: { nome: true } },
      currentNodeId: true,
      currentRound: true,
      profundidade: true,
      snapshotVersion: true,
      flowSnapshot: true,
      // Item 2.7: o grafo congelado mora na FlowVersion (os dois caminhos gravam
      // flowVersionId e deixam o flowSnapshot nulo).
      flowVersionId: true,
      flowVersion: { select: { snapshot: true } },
      status: true,
      nextRunAt: true,
      flowId: true,
    },
  });
  // Mesma versão para todas as inscrições de um fluxo (grafo não copiado por linha).
  const versoesPorFluxo = new Map<string, Set<string | null>>();
  for (const r of rows) versoesPorFluxo.set(r.flowId, (versoesPorFluxo.get(r.flowId) ?? new Set()).add(r.flowVersionId));
  for (const v of versoesPorFluxo.values()) expect(v.size).toBe(1);
  const inicio = await basePrisma.flowNode.findMany({ where: { teamId, nextNodeId: { not: null } }, select: { id: true, flowId: true } });
  const inicioDe = new Map(inicio.map((n) => [n.flowId, n.id]));
  return rows
    .map((r) => {
      expect(r.currentNodeId).toBe(inicioDe.get(r.flowId)); // nó inicial pelo grafo
      expect(r.nextRunAt).not.toBeNull(); // ponteiro completo (a varredura de órfãs enxerga)
      expect(r.status === "waiting" || r.status === "active").toBe(true);
      expect(r.flowVersionId).not.toBeNull();
      expect(r.flowSnapshot).toBeNull();
      return `${r.flow.nome}:${r.contact.nome}:r${r.currentRound}:p${r.profundidade}:v${r.snapshotVersion}:${(r.flowVersion!.snapshot as unknown[]).length}nós`;
    })
    .sort();
}

describe("enrollManyByTrigger — equivalente ao caminho unitário", () => {
  it("mesmas inscrições, com todas as travas", async () => {
    const idsUni = await montarCenario(TEAM_UNI);
    const idsLote = await montarCenario(TEAM_LOTE);

    await runWithTeam(TEAM_UNI, async () => {
      for (const contactId of idsUni) await enrollByTrigger("contact_created", { contactId, emLote: true });
    });
    const chamadasUni = scheduleStep.mock.calls.length;
    scheduleStep.mockClear();
    const r = await runWithTeam(TEAM_LOTE, async () =>
      // Repetido de propósito: o lote deduplica.
      enrollManyByTrigger("contact_created", [...idsLote, idsLote[5]!], { emLote: true }),
    );

    const uni = await inscricoesNovas(TEAM_UNI);
    const lote = await inscricoesNovas(TEAM_LOTE);
    expect(lote).toEqual(uni);
    // Conferência do cenário: 8 no simples − 1 em curso; 7 no nunca; 7 no cooldown; 7 no exclusivo.
    expect(lote).toHaveLength(7 + 7 + 7 + 7);
    expect(lote.some((x) => x.startsWith("simples:C0:"))).toBe(false);
    expect(lote.some((x) => x.startsWith("nunca:C1:"))).toBe(false);
    expect(lote.some((x) => x.startsWith("cooldown:C2:"))).toBe(false);
    expect(lote.some((x) => x.startsWith("cooldown:C3:"))).toBe(true);
    expect(lote.some((x) => x.startsWith("exclusivo:C4:"))).toBe(false);
    expect(r.inscritas).toBe(lote.length);
    // Um 1º passo agendado por inscrição, no round 1, como no unitário.
    expect(scheduleStep.mock.calls).toHaveLength(chamadasUni);
    expect(scheduleStep.mock.calls.every((c) => c[2] === 1)).toBe(true);
  });

  it("lote em paralelo com o mesmo contato: o índice único parcial segura, sem erro", async () => {
    const ids = Array.from({ length: 30 }, () => randomUUID());
    await basePrisma.contact.createMany({ data: ids.map((id, i) => ({ id, teamId: TEAM_LOTE, nome: `P${i}` })) });
    await fluxo(TEAM_LOTE, "simples");
    const [a, b] = await runWithTeam(TEAM_LOTE, async () =>
      Promise.all([enrollManyByTrigger("contact_created", ids), enrollManyByTrigger("contact_created", ids)]),
    );
    const n = await basePrisma.enrollment.count({ where: { teamId: TEAM_LOTE } });
    expect(n).toBe(30);
    expect(a!.inscritas + b!.inscritas).toBe(30);
  });

  it("gatilho de tag filtra pela tag; profundidade acima do teto não inscreve; fluxo de outro time não conta", async () => {
    const ids = Array.from({ length: 3 }, () => randomUUID());
    await basePrisma.contact.createMany({ data: ids.map((id, i) => ({ id, teamId: TEAM_LOTE, nome: `T${i}` })) });
    const tagCerta = randomUUID();
    await fluxo(TEAM_LOTE, "lista", { triggerType: "tag_added", triggerConfig: { tagId: tagCerta } });
    // Fluxo igual no OUTRO time: não pode receber os contatos do lote.
    await fluxo(TEAM_UNI, "lista", { triggerType: "tag_added", triggerConfig: { tagId: tagCerta } });

    await runWithTeam(TEAM_LOTE, async () => {
      expect((await enrollManyByTrigger("tag_added", ids, { tagId: randomUUID() })).inscritas).toBe(0);
      expect((await enrollManyByTrigger("tag_added", ids, { tagId: tagCerta, profundidade: 3 })).inscritas).toBe(0);
      expect((await enrollManyByTrigger("tag_added", ids, { tagId: tagCerta, profundidade: 1 })).inscritas).toBe(3);
    });
    const porTime = await basePrisma.enrollment.groupBy({ by: ["teamId"], where: { teamId: { in: TIMES } }, _count: { _all: true } });
    expect(porTime).toEqual([{ teamId: TEAM_LOTE, _count: { _all: 3 } }]);
    const perf = await basePrisma.enrollment.findFirst({ where: { teamId: TEAM_LOTE }, select: { profundidade: true } });
    expect(perf?.profundidade).toBe(1);
  });
});

describe("importação e tag em massa usam o lote", () => {
  it("importCsv: inscreve cada criado 1× e reconcilia só quem tem conversa", async () => {
    await fluxo(TEAM_LOTE, "boas-vindas");
    // Conversa de um número que ainda não era contato: a importação vincula.
    await basePrisma.conversation.create({ data: { teamId: TEAM_LOTE, canal: "whatsapp", externalNumber: "+5565999990002" } });
    const linhas = Array.from({ length: 700 }, (_, i) => `Pessoa ${i},(65) 9${String(99990000 + i).padStart(8, "0")}`);
    const r = await runWithTeam(TEAM_LOTE, async () => contacts.importCsv(["nome,telefone", ...linhas].join("\n")));
    expect(r.created).toBe(700);

    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM_LOTE } })).toBe(700);
    expect(scheduleStep).toHaveBeenCalledTimes(700);
    const conversa = await basePrisma.conversation.findFirst({ where: { teamId: TEAM_LOTE }, select: { contactId: true } });
    const dono = await basePrisma.contact.findUnique({ where: { id: conversa!.contactId! }, select: { nome: true, relacionamentoStatus: true } });
    expect(dono).toEqual({ nome: "Pessoa 2", relacionamentoStatus: "ja_conversou" });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_LOTE, relacionamentoStatus: "ja_conversou" } })).toBe(1);
  });

  it("assignTagBulk: inscreve os contatos no fluxo da tag de uma vez", async () => {
    const ids = Array.from({ length: 40 }, () => randomUUID());
    await basePrisma.contact.createMany({ data: ids.map((id, i) => ({ id, teamId: TEAM_LOTE, nome: `G${i}` })) });
    const tag = await basePrisma.tag.create({ data: { teamId: TEAM_LOTE, nome: "Parecis" } });
    await fluxo(TEAM_LOTE, "lista-parecis", { triggerType: "tag_added", triggerConfig: { tagId: tag.id } });
    await runWithTeam(TEAM_LOTE, async () => tags.assignTagBulk(ids, tag.id));
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM_LOTE } })).toBe(40);
    // De novo: já estão no fluxo, ninguém entra duas vezes.
    await runWithTeam(TEAM_LOTE, async () => tags.assignTagBulk(ids, tag.id));
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM_LOTE } })).toBe(40);
  });
});
