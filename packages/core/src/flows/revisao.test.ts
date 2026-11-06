import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, db } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { primaryEmail, primaryTelefone } from "../contacts/identifiers";

/**
 * `listReviewEnrollments` sem o snapshot (item 2.7, DP-14): o DTO da aba
 * "Histórico" do fluxo continua o mesmo — tipo do nó corrente, motivo e último
 * erro — sem trazer o grafo de cada inscrição nem todas as execuções.
 */
vi.mock("./queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { listReviewEnrollments } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000002ab";
const OUTRO = "00000000-0000-0000-0000-0000000002ac";
const sufixo = Math.random().toString(36).slice(2, 8);
const agora = Date.now();
const minAtras = (m: number) => new Date(agora - m * 60_000);

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Revisão (test)"], [OUTRO, "Team Revisão B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.flowStepExecution.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.flowNode.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.channelIdentifier.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
  }
});

/** Fluxo com envio → ligação → espera. O snapshot das inscrições tem também um nó "velho" (IA) que saiu do fluxo. */
async function cenario(teamId: string) {
  const id = (x: string) => `${x}-${teamId.slice(-3)}-${sufixo}`;
  const flow = await basePrisma.flow.create({ data: { teamId, nome: `Revisão ${sufixo}`, triggerType: "manual", status: "active" } });
  const nos = [
    { id: id("envio"), tipo: "send_message" },
    { id: id("ligar"), tipo: "manual_call" },
    { id: id("espera"), tipo: "wait" },
  ] as const;
  for (const n of nos) await basePrisma.flowNode.create({ data: { id: n.id, teamId, flowId: flow.id, tipo: n.tipo, config: {} } });
  const snapshot = [...nos, { id: id("velho"), tipo: "ai_agent" }].map((n) => ({ ...n, config: {}, nextNodeId: null }));

  let seq = 0;
  async function inscricao(
    status: "active" | "waiting" | "failed",
    no: string,
    passos: Array<[round: number, erro: string | null, minutosAtras: number]>,
    nextRunAt: Date | null = null,
  ) {
    const c = await basePrisma.contact.create({ data: { teamId, nome: `Contato ${seq}`, empresa: "Fazenda", tags: ["soja"] } });
    await basePrisma.channelIdentifier.create({
      data: { teamId, contactId: c.id, canal: "whatsapp", valor: `+5565999${teamId.slice(-2)}${String(seq++).padStart(4, "0")}`, isPrimary: true },
    });
    const e = await basePrisma.enrollment.create({
      data: { teamId, flowId: flow.id, contactId: c.id, currentNodeId: id(no), currentRound: passos.length || 1, status, nextRunAt, flowSnapshot: snapshot },
    });
    for (const [round, erro, m] of passos) {
      await basePrisma.flowStepExecution.create({
        data: { teamId, enrollmentId: e.id, nodeId: id(no), round, status: erro ? "failed" : "running", error: erro, startedAt: minAtras(m) },
      });
    }
    return e.id;
  }

  return {
    flow,
    segurada: await inscricao("waiting", "envio", [[1, "resultado incerto (pode ter saído): timeout", 2]]),
    ligacao: await inscricao("waiting", "ligar", [[1, null, 3]]),
    falhou: await inscricao("failed", "envio", [[1, "envio não saiu: 1", 10], [2, "envio não saiu: 2", 5], [3, "envio não saiu: final", 1]]),
    noApagado: await inscricao("failed", "velho", [[1, "destino inexistente", 4]]),
    semPasso: await inscricao("failed", "espera", []),
    ativa: await inscricao("active", "envio", [[1, null, 1]], new Date()),
    esperando: await inscricao("waiting", "espera", [[1, null, 1]], new Date(agora + 3_600_000)),
  };
}

/** A implementação ANTERIOR (include com snapshot + stepExecutions take 1), como referência de resultado. */
async function referenciaAntiga(flowId: string) {
  const prisma = db();
  const rows = await prisma.enrollment.findMany({
    where: { flowId, OR: [{ status: "waiting", nextRunAt: null }, { status: "failed" }] },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      contact: { select: { id: true, nome: true, empresa: true, tags: true, identifiers: true } },
      stepExecutions: { orderBy: { startedAt: "desc" }, take: 1, select: { error: true, status: true } },
    },
  });
  return rows.map((r) => {
    const snap = (r.flowSnapshot ?? []) as Array<{ id: string; tipo: string }>;
    const atual = snap.find((n) => n.id === r.currentNodeId);
    return {
      id: r.id,
      contactId: r.contact.id,
      contactNome: r.contact.nome,
      contactEmpresa: r.contact.empresa,
      contactTelefone: primaryTelefone(r.contact.identifiers),
      contactEmail: primaryEmail(r.contact.identifiers),
      contactTags: r.contact.tags,
      status: r.status,
      motivo: atual?.tipo === "manual_call" ? "ligação pendente" : r.status === "failed" ? "falhou" : "segurado p/ revisão",
      currentNodeId: r.currentNodeId,
      currentNodeType: atual?.tipo ?? null,
      erro: r.stepExecutions[0]?.error ?? null,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

describe("listReviewEnrollments sem snapshot", () => {
  it("DTO idêntico ao da implementação anterior", async () => {
    const { flow } = await cenario(TEAM);
    const novo = await runWithTeam(TEAM, () => listReviewEnrollments(flow.id));
    const antigo = await runWithTeam(TEAM, () => referenciaAntiga(flow.id));
    expect(novo).toHaveLength(5);
    expect(novo).toEqual(antigo);
  });

  it("tipo, motivo e último erro de cada caso", async () => {
    const c = await cenario(TEAM);
    const porId = new Map((await runWithTeam(TEAM, () => listReviewEnrollments(c.flow.id))).map((r) => [r.id, r]));

    expect(porId.get(c.segurada)).toMatchObject({ currentNodeType: "send_message", motivo: "segurado p/ revisão", erro: "resultado incerto (pode ter saído): timeout" });
    expect(porId.get(c.ligacao)).toMatchObject({ currentNodeType: "manual_call", motivo: "ligação pendente", erro: null });
    // O erro é o do passo MAIS RECENTE, não o primeiro.
    expect(porId.get(c.falhou)).toMatchObject({ currentNodeType: "send_message", motivo: "falhou", erro: "envio não saiu: final" });
    // Nó apagado do fluxo depois da inscrição: o tipo vem do snapshot dela.
    expect(porId.get(c.noApagado)).toMatchObject({ currentNodeType: "ai_agent", motivo: "falhou", erro: "destino inexistente" });
    expect(porId.get(c.semPasso)).toMatchObject({ currentNodeType: "wait", erro: null });
    // Fora da revisão: ativa e esperando com horário.
    expect(porId.has(c.ativa)).toBe(false);
    expect(porId.has(c.esperando)).toBe(false);
    expect(porId.get(c.segurada)?.contactTelefone).toMatch(/^\+5565999/);
  });

  it("dois times: o fluxo do outro time não devolve nada, e o próprio não mistura", async () => {
    const meu = await cenario(TEAM);
    const deles = await cenario(OUTRO);
    expect(await runWithTeam(TEAM, () => listReviewEnrollments(deles.flow.id))).toEqual([]);
    const lista = await runWithTeam(TEAM, () => listReviewEnrollments(meu.flow.id));
    const idsDeles = new Set(Object.values(deles).filter((v): v is string => typeof v === "string"));
    expect(lista.some((r) => idsDeles.has(r.id))).toBe(false);
  });

  it("fluxo sem ninguém em revisão: lista vazia", async () => {
    const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "vazio", triggerType: "manual", status: "active" } });
    expect(await runWithTeam(TEAM, () => listReviewEnrollments(flow.id))).toEqual([]);
  });
});
