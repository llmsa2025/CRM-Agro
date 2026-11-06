import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma, db, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Incidente de 02/10/2026: muitos contatos entraram num fluxo, o fluxo
 * foi pausado e ativado várias vezes com centenas de passos ainda na fila, e as inscrições ficaram seguradas
 * ("fluxo fora do ar") sem voltar. Aqui o cenário inteiro, em escala, com a fila do motor FALSA (nada roda de verdade)
 * e um "worker" de teste que faz o mesmo que o handler: lê o status do fluxo, segura ou segue e fecha o passo.
 */
const fila = vi.hoisted(() => {
  const jobs = new Map<string, { enrollmentId: string; nodeId: string; round: number }>();
  const ordem: string[] = [];
  const registrar = (e: string, n: string, r: number) => {
    jobs.set(`${e}:${n}:${r}`, { enrollmentId: e, nodeId: n, round: r });
  };
  return {
    jobs,
    ordem,
    scheduleStep: async (e: string, n: string, r: number) => registrar(e, n, r),
    acordarPasso: async (e: string, n: string, r: number) => {
      registrar(e, n, r);
      ordem.push(e);
    },
    removeStepJob: async (id: string) => {
      jobs.delete(id);
    },
  };
});
vi.mock("./queue", () => ({
  scheduleStep: (...a: [string, string, number]) => fila.scheduleStep(...a),
  acordarPasso: (...a: [string, string, number]) => fila.acordarPasso(...a),
  removeStepJob: (id: string) => fila.removeStepJob(id),
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  getFlowQueue: () => ({}),
}));

const { createFlow, pauseFlow, activateFlow } = await import("./service");
const { aplicarStatusDoFluxo, retomarInscricoesSeguradas, varrerSeguradasComFluxoNoAr, MARCA_FLUXO_PAUSADO } = await import("./controle");
const { concluirPasso, jobNoPonteiro } = await import("./avanco");

const TEAM = "00000000-0000-0000-0000-0000000e0001";
const DONO = { userId: "dono-encalhe", role: "owner" };
const comTime = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, DONO);
const sufixo = Math.random().toString(36).slice(2, 8);
const N1 = `en-n1-${sufixo}`;
const N2 = `en-n2-${sufixo}`;
const TOTAL = 1132; // o tamanho do incidente

let flowId = "";
let ids: string[] = [];

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Encalhe (test)" } });
});

/** Apaga tudo do time de teste. Também ao FIM: a varredura de órfãs é cross-team e enxergaria as inscrições velhas deste arquivo nos testes seguintes. */
async function limpar() {
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}

afterAll(limpar);

beforeEach(async () => {
  fila.jobs.clear();
  fila.ordem.length = 0;
  await limpar();
  const f = await comTime(() =>
    createFlow({
      nome: "Encalhe",
      triggerType: "manual",
      nodes: [
        { id: N1, tipo: "wait", config: { duration: 1, unit: "min" }, nextNodeId: N2 },
        { id: N2, tipo: "wait", config: { duration: 1, unit: "min" }, nextNodeId: null },
      ] as never,
    }),
  );
  flowId = f.id;
  await comTime(() => activateFlow(flowId));
});

/** `n` inscrições do fluxo no passo 1, "ativas" com o job na fila, na ordem de entrada (createdAt crescente). */
async function semear(n: number): Promise<string[]> {
  const base = Date.now() - 3_600_000;
  const contatos = Array.from({ length: n }, () => ({ id: randomUUID(), teamId: TEAM, nome: "Lead" }));
  await basePrisma.contact.createMany({ data: contatos });
  const linhas = contatos.map((c, i) => ({
    id: randomUUID(),
    teamId: TEAM,
    flowId,
    contactId: c.id,
    currentNodeId: N1,
    currentRound: 1,
    status: "active" as const,
    nextRunAt: new Date(base),
    createdAt: new Date(base + i), // a ordem original de entrada
  }));
  await basePrisma.enrollment.createMany({ data: linhas });
  for (const l of linhas) await fila.scheduleStep(l.id, N1, 1);
  return linhas.map((l) => l.id);
}

/**
 * O que o handler do worker faz com um job: confere o ponteiro, lê o status do fluxo (ou usa `statusLido`, o valor
 * VELHO que ele leu antes de a fila andar), segura ou segue; seguindo, executa o passo e termina a inscrição.
 */
async function trabalhar(job: { enrollmentId: string; nodeId: string; round: number }, statusLido?: string): Promise<string> {
  const enr = await basePrisma.enrollment.findUniqueOrThrow({ where: { id: job.enrollmentId }, include: { flow: { select: { status: true } } } });
  if (enr.status === "done" || enr.status === "failed") return "terminal";
  if (!jobNoPonteiro(enr, job.nodeId, job.round)) return "obsoleto";
  const status = statusLido ?? enr.flow.status;
  return runAsSystem(TEAM, async () => {
    if (status !== "active") {
      const decisao = await aplicarStatusDoFluxo({ enrollmentId: enr.id, nodeId: job.nodeId, round: job.round, flowStatus: status });
      if (decisao !== "seguir") return decisao;
    }
    await db().flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: enr.id, nodeId: job.nodeId, round: job.round, status: "running" } as never });
    await concluirPasso({ enrollmentId: enr.id, nodeId: job.nodeId, round: job.round, result: { nextNodeId: null } });
    return "executado";
  });
}

/** Processa os jobs `n` de cada vez (como o worker, com concorrência) e devolve o que cada um fez. */
async function rodar(jobs: Array<{ enrollmentId: string; nodeId: string; round: number }>, statusLido?: string, n = 12): Promise<string[]> {
  const feitos: string[] = [];
  for (let i = 0; i < jobs.length; i += n) feitos.push(...(await Promise.all(jobs.slice(i, i + n).map((j) => trabalhar(j, statusLido)))));
  return feitos;
}

const contar = async () => {
  const g = await basePrisma.enrollment.groupBy({ by: ["status", "waitingFor"], where: { flowId }, _count: { _all: true } });
  const de = (status: string, waitingFor: string | null = null) => g.find((x) => x.status === status && x.waitingFor === waitingFor)?._count._all ?? 0;
  return { done: de("done"), ativas: de("active"), seguradas: de("waiting", MARCA_FLUXO_PAUSADO) };
};

describe("1.132 inscritas: pausar, retomar e salvar não deixam ninguém encalhado", () => {
  it("o cenário de 02/10: pausa e ativa em sequência, o worker lendo status velho, e todas terminam", async () => {
    ids = await semear(TOTAL);

    // 1) O usuário pausa com a fila cheia: todas ficam seguradas na hora.
    expect((await comTime(() => pauseFlow(flowId))).seguradas).toBe(TOTAL);
    expect(await contar()).toEqual({ done: 0, ativas: 0, seguradas: TOTAL });

    // 2) O worker passa pelos jobs velhos vendo "pausado": não executa nada, e nada se perde.
    expect(new Set(await rodar([...fila.jobs.values()].slice(0, 120)))).toEqual(new Set(["segurado"]));

    // 3) Ativa: todas voltam, UMA vez cada, na ordem original de entrada.
    fila.ordem.length = 0;
    const a = await comTime(() => activateFlow(flowId));
    expect(a.retomadas).toBe(TOTAL);
    expect(fila.ordem).toEqual(ids);
    expect(await contar()).toEqual({ done: 0, ativas: TOTAL, seguradas: 0 });

    // 4) O worker executa 100 e o usuário pausa de novo no meio.
    expect(new Set(await rodar([...fila.jobs.values()].slice(0, 100)))).toEqual(new Set(["executado"]));
    expect((await comTime(() => pauseFlow(flowId))).seguradas).toBe(TOTAL - 100);

    // 5) Corrida do incidente: 40 jobs já tinham lido "pausado" ANTES de o usuário ativar e seguram DEPOIS da retomada.
    const retomadas = await comTime(() => activateFlow(flowId));
    expect(retomadas.retomadas).toBe(TOTAL - 100);
    const velhos = [...fila.jobs.values()].filter((j) => j.enrollmentId !== ids[0]).slice(200, 240);
    expect(new Set(await rodar(velhos, "paused"))).toEqual(new Set(["executado"])); // o fluxo voltou ao ar: segue, não segura

    // 6) O resto da fila anda e TODAS terminam; nenhuma fica segurada com o fluxo no ar.
    await rodar([...fila.jobs.values()]);
    expect(await contar()).toEqual({ done: TOTAL, ativas: 0, seguradas: 0 });
  }, 120_000);

  it("a segurada confere o status ATUAL: o passo que leu 'pausado' não segura depois da reativação", async () => {
    const [id] = await semear(1);
    // O fluxo já voltou ao ar (nada seguro no banco), mas o worker ainda tem o status velho na mão.
    const decisao = await runAsSystem(TEAM, () => aplicarStatusDoFluxo({ enrollmentId: id!, nodeId: N1, round: 1, flowStatus: "paused" }));
    expect(decisao).toBe("seguir");
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: "active", waitingFor: null });

    // Com o fluxo realmente pausado, segura (como sempre).
    await comTime(() => pauseFlow(flowId));
    await basePrisma.enrollment.update({ where: { id: id! }, data: { status: "active", waitingFor: null, nextRunAt: new Date() } });
    expect(await runAsSystem(TEAM, () => aplicarStatusDoFluxo({ enrollmentId: id!, nodeId: N1, round: 1, flowStatus: "paused" }))).toBe("segurado");
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: "waiting", waitingFor: MARCA_FLUXO_PAUSADO, nextRunAt: null });
  });

  it("retomar de novo, ou duas retomadas ao mesmo tempo, não agenda ninguém em dobro", async () => {
    ids = await semear(500);
    await comTime(() => pauseFlow(flowId));
    // O fluxo volta ao ar SEM passar pela retomada do activateFlow (como numa ativação interrompida no meio).
    await basePrisma.flow.update({ where: { id: flowId }, data: { status: "active" } });

    fila.ordem.length = 0;
    const [x, y] = await Promise.all([comTime(() => retomarInscricoesSeguradas(flowId)), comTime(() => retomarInscricoesSeguradas(flowId))]);
    expect(x + y).toBe(500); // cada inscrição foi solta por UMA das duas
    expect(new Set(fila.ordem)).toEqual(new Set(ids)); // e todas ganharam o job (um só por jobId; `acordarPasso` repetido é inofensivo)
    expect(fila.jobs.size).toBe(500);
    expect(await contar()).toEqual({ done: 0, ativas: 500, seguradas: 0 });
    expect(await comTime(() => retomarInscricoesSeguradas(flowId))).toBe(0);
  });

  it("retomada com o fluxo pausado não solta ninguém", async () => {
    ids = await semear(50);
    await comTime(() => pauseFlow(flowId));
    expect(await comTime(() => retomarInscricoesSeguradas(flowId))).toBe(0);
    expect((await contar()).seguradas).toBe(50);
  });
});

describe("varredura: segurada pela pausa com o fluxo no ar volta sozinha", () => {
  /** Estado herdado do incidente: fluxo no ar e inscrições paradas em `fluxo_pausado` há 10 min. */
  async function encalhar(n: number, haMin: number) {
    ids = await semear(n);
    await comTime(() => pauseFlow(flowId));
    await basePrisma.flow.update({ where: { id: flowId }, data: { status: "active" } }); // reativado sem retomar
    await basePrisma.enrollment.updateMany({ where: { flowId }, data: { updatedAt: new Date(Date.now() - haMin * 60_000) } as never });
  }

  it("retoma, em ordem e uma vez só, o que está parado há mais que a carência", async () => {
    await encalhar(300, 10);
    fila.ordem.length = 0;
    const r = await varrerSeguradasComFluxoNoAr({ teamId: TEAM });
    expect(r).toEqual({ fluxos: 1, retomadas: 300 });
    expect(fila.ordem).toEqual(ids);
    expect(await contar()).toEqual({ done: 0, ativas: 300, seguradas: 0 });
    expect(await varrerSeguradasComFluxoNoAr({ teamId: TEAM })).toEqual({ fluxos: 0, retomadas: 0 });
  });

  it("não atropela uma ativação em andamento (parada há menos que a carência)", async () => {
    await encalhar(20, 0);
    expect(await varrerSeguradasComFluxoNoAr({ teamId: TEAM })).toEqual({ fluxos: 0, retomadas: 0 });
    expect((await contar()).seguradas).toBe(20);
  });

  it("não toca em fluxo pausado de verdade", async () => {
    ids = await semear(20);
    await comTime(() => pauseFlow(flowId));
    await basePrisma.enrollment.updateMany({ where: { flowId }, data: { updatedAt: new Date(Date.now() - 3_600_000) } as never });
    expect(await varrerSeguradasComFluxoNoAr({ teamId: TEAM })).toEqual({ fluxos: 0, retomadas: 0 });
    expect((await contar()).seguradas).toBe(20);
  });

  it("respeita o teto por fluxo: o resto fica para a próxima rodada", async () => {
    await encalhar(250, 10);
    const a = await varrerSeguradasComFluxoNoAr({ teamId: TEAM, limitePorFluxo: 200 });
    expect(a.retomadas).toBeGreaterThanOrEqual(200);
    expect(a.retomadas).toBeLessThan(250);
    const b = await varrerSeguradasComFluxoNoAr({ teamId: TEAM, limitePorFluxo: 200 });
    expect(a.retomadas + b.retomadas).toBe(250);
  });
});
