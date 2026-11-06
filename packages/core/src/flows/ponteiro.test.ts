import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam as runWithTeamDb } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Justiça entre times + ponteiro da inscrição + snapshot tolerante (item 1.9 —
 * MF-20, MF-17, MF-18). Fila BullMQ mockada; Redis de TESTE real no balde.
 */
const fila = vi.hoisted(() => ({ scheduleStep: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => fila.scheduleStep(...a),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));

const { concluirPasso, jobNoPonteiro } = await import("./avanco");
const { redirectEnrollment, completeManualCall, activateFlow, updateFlow } = await import("./service");
const { lerNoDoSnapshot, referenciasPendentes } = await import("./snapshot");
const { reservarVezDoTime } = await import("./justica");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM = "00000000-0000-0000-0000-0000000000cf";
const OUTRO = "00000000-0000-0000-0000-0000000000d0";
const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
const uid = (p: string) => `${p}-${sufixo}-${seq++}`;

const SNAP = [
  { id: "ligar", tipo: "manual_call", config: {}, nextNodeId: "msg" },
  { id: "msg", tipo: "add_tag", config: { tag: "x" }, nextNodeId: null },
];

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Ponteiro ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  fila.scheduleStep.mockClear();
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.flowStepExecution.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.flowNode.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
  }
});

async function inscricao(extra: { status?: "active" | "waiting" | "done"; currentNodeId?: string; currentRound?: number } = {}) {
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: uid("F"), triggerType: "manual", status: "active" } });
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  return basePrisma.enrollment.create({
    data: {
      teamId: TEAM,
      flowId: flow.id,
      contactId: c.id,
      currentNodeId: extra.currentNodeId ?? "ligar",
      currentRound: extra.currentRound ?? 1,
      status: extra.status ?? "waiting",
      nextRunAt: null,
      flowSnapshot: SNAP as never,
    },
  });
}

describe("ponteiro da inscrição (MF-17)", () => {
  it("job só roda no passo em que a inscrição está (round 0 = inscrição antiga)", () => {
    expect(jobNoPonteiro({ currentNodeId: "a", currentRound: 2 }, "a", 2)).toBe(true);
    expect(jobNoPonteiro({ currentNodeId: "a", currentRound: 3 }, "a", 2)).toBe(false);
    expect(jobNoPonteiro({ currentNodeId: "b", currentRound: 2 }, "a", 2)).toBe(false);
    expect(jobNoPonteiro({ currentNodeId: "a", currentRound: 0 }, "a", 7)).toBe(true);
  });

  it("'definir destino' clicado duas vezes: o 2º é recusado e só UMA linha é agendada", async () => {
    const e = await inscricao();
    await runWithTeam(TEAM, () => redirectEnrollment(e.id, "msg"));
    await expect(runWithTeam(TEAM, () => redirectEnrollment(e.id, "msg"))).rejects.toMatchObject({ name: "EnrollmentChanged" });
    expect(fila.scheduleStep).toHaveBeenCalledTimes(1);
  });

  it("redirect com o ponteiro que a TELA viu, já desatualizado → recusa", async () => {
    const e = await inscricao();
    await expect(
      runWithTeam(TEAM, () => redirectEnrollment(e.id, "msg", { nodeId: "outro-no" })),
    ).rejects.toMatchObject({ name: "EnrollmentChanged" });
    expect(fila.scheduleStep).not.toHaveBeenCalled();
  });

  it("'ligação feita' clicado duas vezes: registra uma vez e avança uma vez", async () => {
    const e = await inscricao();
    await runWithTeam(TEAM, () => completeManualCall(e.id, { resumo: "falei" }));
    await expect(runWithTeam(TEAM, () => completeManualCall(e.id, { resumo: "falei" }))).rejects.toMatchObject({ name: "EnrollmentChanged" });
    expect(fila.scheduleStep).toHaveBeenCalledTimes(1);
    expect(await basePrisma.activity.count({ where: { teamId: TEAM, tipo: "call" } })).toBe(1);
  });

  it("passo que termina depois de um redirect NÃO move o ponteiro (compare-and-set)", async () => {
    const e = await inscricao({ status: "active", currentNodeId: "ligar", currentRound: 1 });
    await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: e.id, nodeId: "ligar", round: 1, status: "running" } });
    // Enquanto o passo rodava, alguém mandou a inscrição para "msg".
    await basePrisma.enrollment.update({ where: { id: e.id }, data: { currentNodeId: "msg", currentRound: 1 } });
    const prox = await runWithTeam(TEAM, () => concluirPasso({ enrollmentId: e.id, nodeId: "ligar", round: 1, result: { nextNodeId: "msg" } }));
    expect(prox).toBeNull();
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ currentNodeId: "msg", stepNumber: 0 });
    expect((await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: e.id } })).status).toBe("done");
  });

  it("'parar tudo' durante o passo: o passo termina e NÃO ressuscita a inscrição", async () => {
    const e = await inscricao({ status: "active" });
    await basePrisma.enrollment.update({ where: { id: e.id }, data: { status: "done" } });
    const prox = await runWithTeam(TEAM, () => concluirPasso({ enrollmentId: e.id, nodeId: "ligar", round: 1, result: { nextNodeId: "msg" } }));
    expect(prox).toBeNull();
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("done");
  });

  it("dois times: redirect de inscrição de outro time não acha nada", async () => {
    const e = await inscricao();
    await expect(
      runWithTeamDb(OUTRO, () => redirectEnrollment(e.id, "msg"), { userId: "u", role: "owner" }),
    ).rejects.toMatchObject({ name: "EnrollmentNotFound" });
  });
});

describe("snapshot tolerante (MF-18)", () => {
  it("valida SÓ o nó corrente: outro nó fora do schema atual não derruba a inscrição", () => {
    const snap = [{ id: "a", tipo: "add_tag", config: { tag: "x" }, nextNodeId: null }, { id: "velho", tipo: "tipo_que_sumiu", config: {} }];
    expect(lerNoDoSnapshot(snap, "a")).toMatchObject({ ok: true, node: { id: "a", tipo: "add_tag" } });
  });

  it("nó ausente = 'destino inexistente' (antes: encerrava como concluído); nó inválido traz o motivo", () => {
    expect(lerNoDoSnapshot([{ id: "a", tipo: "add_tag", config: { tag: "x" }, nextNodeId: null }], "b")).toMatchObject({
      ok: false,
      motivo: "destino_inexistente",
    });
    const r = lerNoDoSnapshot([{ id: "a", tipo: "add_tag", config: {}, nextNodeId: null }], "a");
    expect(r).toMatchObject({ ok: false, motivo: "no_invalido" });
    expect(!r.ok && r.erro).toMatch(/nó a \(add_tag\) inválido/);
    expect(lerNoDoSnapshot(null, "a")).toMatchObject({ ok: false, motivo: "snapshot_invalido" });
  });

  it("setas soltas: próximo, ramos da condição, variantes do A/B e padrão", () => {
    const soltas = referenciasPendentes([
      { id: "a", tipo: "add_tag", nextNodeId: "sumiu1" },
      { id: "c", tipo: "condition", branches: { branches: [{ nextNodeId: "a" }, { nextNodeId: "sumiu2" }], default: "sumiu3" } },
      { id: "ab", tipo: "ab_split", branches: { variants: [{ nextNodeId: "c" }, { nextNodeId: "sumiu4" }] } },
    ]);
    expect(soltas.map((s) => s.para).sort()).toEqual(["sumiu1", "sumiu2", "sumiu3", "sumiu4"]);
  });

  it("ativar fluxo com seta solta é recusado; rascunho pode ser salvo com ela, fluxo ativo não", async () => {
    const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: uid("F"), triggerType: "manual", status: "draft" } });
    const nos = [{ id: uid("n"), tipo: "add_tag", config: { tag: "x" }, nextNodeId: "nao-existe" }];
    await runWithTeam(TEAM, () => updateFlow(flow.id, { nodes: nos } as never));
    await expect(runWithTeam(TEAM, () => activateFlow(flow.id))).rejects.toMatchObject({ name: "InvalidGraphError" });
    await basePrisma.flow.update({ where: { id: flow.id }, data: { status: "active" } });
    await expect(runWithTeam(TEAM, () => updateFlow(flow.id, { nodes: nos } as never))).rejects.toMatchObject({ name: "InvalidGraphError" });
  });
});

describe("justiça entre times (MF-20)", () => {
  it("cada time tem o próprio balde: o time barulhento espera, o vizinho passa", async () => {
    const a = uid("time-a");
    const b = uid("time-b");
    await redisEstado().del(`flow:balde:${a}`, `flow:balde:${b}`);
    const agora = Date.now();
    const pedidos = [];
    for (let i = 0; i < 4; i++) pedidos.push(await reservarVezDoTime(a, { porMinuto: 3, agora }));
    expect(pedidos.slice(0, 3)).toEqual([0, 0, 0]);
    expect(pedidos[3]).toBeGreaterThan(0); // 4º passo do minuto: espera a ficha (~20 s)
    expect(pedidos[3]).toBeLessThanOrEqual(20_000);
    expect(await reservarVezDoTime(b, { porMinuto: 3, agora })).toBe(0);
    // 20 s depois repôs uma ficha.
    expect(await reservarVezDoTime(a, { porMinuto: 3, agora: agora + 20_001 })).toBe(0);
  });
});
