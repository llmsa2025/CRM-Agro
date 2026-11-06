import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Inscrições órfãs e dupla inscrição (auditoria MF-01, MF-04 — item 0.9).
 * A fila é mockada: nada vai para o Redis e nada é enviado.
 */
const scheduleStep = vi.fn(async () => {});
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => scheduleStep(...(a as [])),
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { concluirPasso, reagendarPeloPonteiro, varrerInscricoesOrfas } = await import("./avanco");
const { enroll } = await import("./service");
const { enrollByTrigger } = await import("./triggers");
const { InvalidGraphError } = await import("./errors");

const TEAM = "00000000-0000-0000-0000-0000000000fe";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${seq++}`;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Avanço (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

async function cenario(triggerType: "manual" | "contact_created" = "manual") {
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  const n1 = uid("n1");
  const n2 = uid("n2");
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "F", triggerType, status: "active" } });
  await basePrisma.flowNode.create({
    data: { id: n1, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never, nextNodeId: n2 },
  });
  await basePrisma.flowNode.create({
    data: { id: n2, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never, nextNodeId: null },
  });
  return { contato, flow, n1, n2 };
}

async function inscricaoRodando(c: Awaited<ReturnType<typeof cenario>>) {
  const enr = await basePrisma.enrollment.create({
    data: { teamId: TEAM, flowId: c.flow.id, contactId: c.contato.id, currentNodeId: c.n1, currentRound: 1, status: "active", nextRunAt: new Date() },
  });
  await basePrisma.flowStepExecution.create({
    data: { teamId: TEAM, enrollmentId: enr.id, nodeId: c.n1, round: 1, status: "running" },
  });
  return enr;
}

describe("concluirPasso — passo e ponteiro na mesma transação", () => {
  it("fecha o passo e aponta a inscrição para o próximo (nó + round + hora)", async () => {
    const c = await cenario();
    const enr = await inscricaoRodando(c);
    const agora = new Date();
    const prox = await runWithTeam(TEAM, () =>
      concluirPasso({ enrollmentId: enr.id, nodeId: c.n1, round: 1, result: { nextNodeId: c.n2, delayMs: 60_000 }, agora }),
    );
    expect(prox).toEqual({ nodeId: c.n2, round: 1, delayMs: 60_000 });
    const depois = await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } });
    expect(depois).toMatchObject({ currentNodeId: c.n2, currentRound: 1, status: "waiting" });
    expect(depois.nextRunAt?.getTime()).toBe(agora.getTime() + 60_000);
    const passo = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id, nodeId: c.n1 } });
    expect(passo.status).toBe("done");
  });

  it("reentrada no mesmo nó (poll) vira round + 1; hold trava sem próximo", async () => {
    const c = await cenario();
    const enr = await inscricaoRodando(c);
    const poll = await runWithTeam(TEAM, () =>
      concluirPasso({ enrollmentId: enr.id, nodeId: c.n1, round: 1, result: { nextNodeId: c.n1, delayMs: 30_000 } }),
    );
    expect(poll).toMatchObject({ nodeId: c.n1, round: 2 });

    await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: enr.id, nodeId: c.n1, round: 2, status: "running" } });
    const hold = await runWithTeam(TEAM, () =>
      concluirPasso({ enrollmentId: enr.id, nodeId: c.n1, round: 2, result: { nextNodeId: c.n2, hold: true } }),
    );
    expect(hold).toBeNull();
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).toMatchObject({
      status: "waiting",
      nextRunAt: null,
    });
  });
});

describe("órfã: falha entre fechar o passo e agendar o próximo", () => {
  it("o agendamento falhou → a varredura reagenda pelo ponteiro, com o horário original", async () => {
    const c = await cenario();
    const enr = await inscricaoRodando(c);
    await runWithTeam(TEAM, () =>
      concluirPasso({ enrollmentId: enr.id, nodeId: c.n1, round: 1, result: { nextNodeId: c.n2 } }),
    );
    // (o scheduleStep "falhou": não foi chamado)
    const devido = (await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).nextRunAt!;
    const agendar = vi.fn(async () => {});
    const r = await varrerInscricoesOrfas({
      agora: new Date(devido.getTime() + 10 * 60_000),
      fila: { estado: async () => null, remover: async () => {}, agendar },
    });
    expect(r.reagendadas).toBeGreaterThanOrEqual(1);
    expect(agendar).toHaveBeenCalledWith(enr.id, c.n2, 1, undefined, devido.getTime());
  });

  it("job vivo não é duplicado; job 'failed' marca a inscrição; 'completed' parado é refeito", async () => {
    const c = await cenario();
    const enr = await inscricaoRodando(c);
    await basePrisma.enrollment.update({ where: { id: enr.id }, data: { nextRunAt: new Date(Date.now() - 3600_000) } });
    const agendar = vi.fn(async () => {});
    const remover = vi.fn(async () => {});
    const soEsta = async (estado: string | null) =>
      varrerInscricoesOrfas({
        fila: { estado: async (id) => (id.startsWith(enr.id) ? estado : "delayed"), remover, agendar },
      });

    await soEsta("delayed");
    expect(agendar).not.toHaveBeenCalledWith(enr.id, expect.anything(), expect.anything(), undefined, expect.anything());

    await soEsta("completed");
    expect(remover).toHaveBeenCalledWith(`${enr.id}:${c.n1}:1`);
    expect(agendar).toHaveBeenCalledWith(enr.id, c.n1, 1, undefined, expect.any(Number));

    await soEsta("failed");
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).status).toBe("failed");
  });

  it("inscrição antiga (sem currentRound) usa o histórico para achar o round", async () => {
    const c = await cenario();
    const enr = await basePrisma.enrollment.create({
      data: {
        teamId: TEAM,
        flowId: c.flow.id,
        contactId: c.contato.id,
        currentNodeId: c.n1,
        currentRound: 0,
        status: "active",
        nextRunAt: new Date(Date.now() - 3600_000),
      },
    });
    for (const r of [1, 2, 3]) {
      await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: enr.id, nodeId: c.n1, round: r, status: "done" } });
    }
    const agendar = vi.fn(async () => {});
    await varrerInscricoesOrfas({
      fila: { estado: async (id) => (id.startsWith(enr.id) ? null : "delayed"), remover: async () => {}, agendar },
    });
    expect(agendar).toHaveBeenCalledWith(enr.id, c.n1, 4, undefined, expect.any(Number));
  });

  it("retry que acha o passo já 'done' reagenda pelo ponteiro (idempotente pelo jobId)", async () => {
    const c = await cenario();
    const enr = await inscricaoRodando(c);
    await runWithTeam(TEAM, () =>
      concluirPasso({ enrollmentId: enr.id, nodeId: c.n1, round: 1, result: { nextNodeId: c.n2 } }),
    );
    expect(await runWithTeam(TEAM, () => reagendarPeloPonteiro(enr.id))).toBe(true);
    expect(scheduleStep).toHaveBeenCalledWith(enr.id, c.n2, 1, undefined, expect.any(Number));
  });
});

describe("dupla inscrição (MF-04)", () => {
  it("dois 'Testar' simultâneos → 1 inscrição; o outro recebe 'já está percorrendo'", async () => {
    const c = await cenario();
    const r = await Promise.allSettled([
      runWithTeam(TEAM, () => enroll(c.contato.id, c.flow.id)),
      runWithTeam(TEAM, () => enroll(c.contato.id, c.flow.id)),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const falha = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(falha.reason).toBeInstanceOf(InvalidGraphError);
    expect(await basePrisma.enrollment.count({ where: { flowId: c.flow.id } })).toBe(1);
    // Nasce com o ponteiro completo (round 1 e hora) — a varredura enxerga.
    expect(await basePrisma.enrollment.findFirstOrThrow({ where: { flowId: c.flow.id } })).toMatchObject({
      currentRound: 1,
      nextRunAt: expect.any(Date),
    });
  });

  it("gatilho disparado 3× ao mesmo tempo → 1 inscrição, 1 agendamento", async () => {
    const c = await cenario("contact_created");
    await Promise.all(
      [1, 2, 3].map(() => runWithTeam(TEAM, () => enrollByTrigger("contact_created", { contactId: c.contato.id }))),
    );
    expect(await basePrisma.enrollment.count({ where: { flowId: c.flow.id } })).toBe(1);
    expect(scheduleStep).toHaveBeenCalledTimes(1);
  });
});
