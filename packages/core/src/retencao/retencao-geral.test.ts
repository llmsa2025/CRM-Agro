import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Job geral de retenção (item 2.7, DP-15; decisão do dono: 90 dias). Cada
 * chamada passa `teamId` do time de teste: a base de TESTE é compartilhada e o
 * job, em produção, é cross-team.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const {
  limparPassosDeInscricoesEncerradas,
  limparRascunhosTratados,
  limparFatosNaoAplicados,
  executarRetencao,
  _reiniciarRetencaoGeral,
} = await import("./service");
const { redirectEnrollment } = await import("../flows/service");

const TEAM = "00000000-0000-0000-0000-0000000002a7";
const OUTRO = "00000000-0000-0000-0000-0000000002a8";
const DIA = 86_400_000;
const atras = (dias: number) => new Date(Date.now() - dias * DIA);

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Retenção (test)"], [OUTRO, "Team Retenção B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.flowStepExecution.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
    await basePrisma.prospectDraft.deleteMany({ where: w });
    await basePrisma.enrichmentFact.deleteMany({ where: w });
  }
});

let seq = 0;

/**
 * Inscrição com `passos` já executados (nó, round, status) e `updatedAt` =
 * `diasParada` atrás (a última vez que andou).
 */
async function inscricao(
  teamId: string,
  status: "active" | "waiting" | "done" | "failed",
  diasParada: number,
  passos: Array<[nodeId: string, round: number, status?: "done" | "failed" | "skipped"]>,
  extra: { currentNodeId?: string; nextRunAt?: Date | null } = {},
) {
  const flow = await basePrisma.flow.create({
    data: {
      teamId,
      nome: `F${seq++}`,
      triggerType: "manual",
      status: "active",
      nodes: {
        create: ["a", "b", "c"].map((id) => ({ id: `${id}-${teamId.slice(-3)}-${seq}`, teamId, tipo: "wait" as never, config: {} as never })),
      },
    },
    include: { nodes: true },
  });
  const no = (x: string) => flow.nodes.find((n) => n.id.startsWith(`${x}-`))!.id;
  const contato = await basePrisma.contact.create({ data: { teamId, nome: `C${seq}` } });
  const snapshot = flow.nodes.map((n) => ({ id: n.id, tipo: "wait", config: { amount: 1, unit: "minutes" }, nextNodeId: null }));
  const enr = await basePrisma.enrollment.create({
    data: {
      teamId,
      flowId: flow.id,
      contactId: contato.id,
      currentNodeId: no(extra.currentNodeId ?? "a"),
      currentRound: 1,
      status,
      nextRunAt: extra.nextRunAt === undefined ? null : extra.nextRunAt,
      flowSnapshot: snapshot,
    },
  });
  for (const [nodeId, round, st] of passos) {
    await basePrisma.flowStepExecution.create({
      data: { teamId, enrollmentId: enr.id, nodeId: no(nodeId), round, status: st ?? "done", startedAt: atras(diasParada + 1) },
    });
  }
  // Por último: qualquer escrita na inscrição renova o @updatedAt.
  await basePrisma.enrollment.update({ where: { id: enr.id }, data: { updatedAt: atras(diasParada) } });
  return { id: enr.id, no };
}

const passosDe = (enrollmentId: string) =>
  basePrisma.flowStepExecution.findMany({ where: { enrollmentId }, select: { nodeId: true, round: true }, orderBy: [{ nodeId: "asc" }, { round: "asc" }] });

describe("retenção de FlowStepExecution (90 dias)", () => {
  it("apaga os passos de inscrição done parada há > 90 dias; a inscrição fica (resumo)", async () => {
    const velha = await inscricao(TEAM, "done", 91, [["a", 1], ["b", 1]]);
    const recente = await inscricao(TEAM, "done", 10, [["a", 1]]);

    const r = await limparPassosDeInscricoesEncerradas({ teamId: TEAM });
    expect(r.apagados).toBe(2);
    expect(await passosDe(velha.id)).toHaveLength(0);
    expect(await basePrisma.enrollment.findUnique({ where: { id: velha.id } })).not.toBeNull();
    expect(await passosDe(recente.id)).toHaveLength(1);
  });

  it("NUNCA toca inscrição active/waiting, nem a segurada para revisão (waiting sem nextRunAt)", async () => {
    const ativa = await inscricao(TEAM, "active", 200, [["a", 1]], { nextRunAt: atras(199) });
    const esperando = await inscricao(TEAM, "waiting", 200, [["a", 1]], { nextRunAt: new Date(Date.now() + DIA) });
    const segurada = await inscricao(TEAM, "waiting", 200, [["a", 1], ["b", 1, "failed"]], { currentNodeId: "b", nextRunAt: null });

    expect((await limparPassosDeInscricoesEncerradas({ teamId: TEAM })).apagados).toBe(0);
    expect(await passosDe(ativa.id)).toHaveLength(1);
    expect(await passosDe(esperando.id)).toHaveLength(1);
    expect(await passosDe(segurada.id)).toHaveLength(2);
  });

  it("failed: preserva todas as rodadas do nó corrente; 'definir destino' depois segue sem colisão de round", async () => {
    const f = await inscricao(TEAM, "failed", 120, [["a", 1], ["b", 1, "failed"], ["b", 2, "failed"], ["c", 1]], { currentNodeId: "b" });

    expect((await limparPassosDeInscricoesEncerradas({ teamId: TEAM })).apagados).toBe(2);
    const ficaram = await passosDe(f.id);
    expect(ficaram.map((p) => [p.nodeId, p.round])).toEqual([[f.no("b"), 1], [f.no("b"), 2]]);

    // O erro que a revisão mostra continua lá, e voltar ao nó corrente usa o round 3.
    await runWithTeam(TEAM, () => redirectEnrollment(f.id, f.no("b")));
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ status: "active", currentRound: 3 });
  });

  it("lotes pequenos: o cursor por id atravessa linhas preservadas e apaga tudo o que pode", async () => {
    // 3 inscrições done (2 passos cada) + 1 failed com 2 passos preservados.
    const done = [];
    for (let i = 0; i < 3; i++) done.push(await inscricao(TEAM, "done", 100, [["a", 1], ["b", 1]]));
    const f = await inscricao(TEAM, "failed", 100, [["a", 1], ["a", 2, "failed"]]);

    const r = await limparPassosDeInscricoesEncerradas({ teamId: TEAM, lote: 2 });
    expect(r.apagados).toBe(6);
    for (const d of done) expect(await passosDe(d.id)).toHaveLength(0);
    expect(await passosDe(f.id)).toHaveLength(2);
  });

  it("dois times: limpeza restrita ao time A não encosta no time B", async () => {
    await inscricao(TEAM, "done", 100, [["a", 1]]);
    const b = await inscricao(OUTRO, "done", 100, [["a", 1]]);
    expect((await limparPassosDeInscricoesEncerradas({ teamId: TEAM })).apagados).toBe(1);
    expect(await passosDe(b.id)).toHaveLength(1);
  });
});

describe("retenção de rascunhos tratados (30 dias) e fatos não aplicados (180 dias)", () => {
  it("rascunho importado/descartado > 30 dias sai; recente e pendente ficam", async () => {
    const mk = (teamId: string, status: string, dias: number) =>
      basePrisma.prospectDraft.create({ data: { teamId, origem: "maps", lote: "l", nome: `${status}-${dias}`, status, createdAt: atras(dias) } });
    const importado = await mk(TEAM, "importado", 31);
    const descartado = await mk(TEAM, "descartado", 45);
    const recente = await mk(TEAM, "importado", 5);
    const pendente = await mk(TEAM, "pendente", 60); // é do job de pendentes (H.1), não deste
    const deOutro = await mk(OUTRO, "importado", 60);

    expect((await limparRascunhosTratados({ teamId: TEAM })).apagados).toBe(2);
    const ficaram = await basePrisma.prospectDraft.findMany({ where: { teamId: { in: [TEAM, OUTRO] } }, select: { id: true } });
    expect(ficaram.map((d) => d.id).sort()).toEqual([recente.id, pendente.id, deOutro.id].sort());
    expect(ficaram.map((d) => d.id)).not.toContain(importado.id);
    expect(ficaram.map((d) => d.id)).not.toContain(descartado.id);
  });

  it("fato nunca aplicado > 180 dias sai; aplicado, recente e humano ficam", async () => {
    const mk = (teamId: string, dias: number, extra: { appliedAt?: Date; source?: string } = {}) =>
      basePrisma.enrichmentFact.create({
        data: {
          teamId,
          targetType: "contact",
          targetId: "x",
          field: "cnae",
          value: "0111",
          enricherKey: "cnpj",
          enricherVersion: "v1",
          source: extra.source ?? "cnpja",
          producedAt: atras(dias),
          appliedAt: extra.appliedAt ?? null,
        },
      });
    const velho = await mk(TEAM, 181);
    const aplicado = await mk(TEAM, 400, { appliedAt: atras(400) });
    const recente = await mk(TEAM, 100);
    const humano = await mk(TEAM, 400, { source: "human" });
    const deOutro = await mk(OUTRO, 400);

    expect((await limparFatosNaoAplicados({ teamId: TEAM })).apagados).toBe(1);
    const ficaram = await basePrisma.enrichmentFact.findMany({ where: { teamId: { in: [TEAM, OUTRO] } }, select: { id: true } });
    expect(ficaram.map((f) => f.id).sort()).toEqual([aplicado.id, recente.id, humano.id, deOutro.id].sort());
    expect(ficaram.map((f) => f.id)).not.toContain(velho.id);
  });
});

describe("executarRetencao (o que o worker chama a cada 6 h)", () => {
  it("o job geral roda no máximo 1× a cada 24 h; os pendentes, sempre", async () => {
    _reiniciarRetencaoGeral();
    const t0 = new Date();
    await inscricao(TEAM, "done", 100, [["a", 1]]);

    const r1 = await executarRetencao({ agora: t0, teamId: TEAM });
    expect(r1.geral).toEqual({ passos: 1, rascunhosTratados: 0, fatos: 0, tarefasFeitas: 0 });

    const r2 = await executarRetencao({ agora: new Date(t0.getTime() + 6 * 3_600_000), teamId: TEAM });
    expect(r2.geral).toBeNull();
    expect(r2.rascunhosPendentes).toBe(0);

    const r3 = await executarRetencao({ agora: new Date(t0.getTime() + 25 * 3_600_000), teamId: TEAM });
    expect(r3.geral).not.toBeNull();
  });
});
