import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Pausar e retomar o fluxo. Pausar segura NA HORA toda inscrição em andamento no passo em que está; ativar de
 * novo continua de onde parou. A fila do motor é mockada (nada roda de verdade).
 */
const fila = vi.hoisted(() => ({
  scheduleStep: vi.fn(async (..._a: unknown[]) => {}),
  acordarPasso: vi.fn(async (..._a: unknown[]) => {}),
  removeStepJob: vi.fn(async (..._a: unknown[]) => {}),
}));
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => fila.scheduleStep(...a),
  acordarPasso: (...a: unknown[]) => fila.acordarPasso(...a),
  removeStepJob: (...a: unknown[]) => fila.removeStepJob(...a),
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  getFlowQueue: () => ({}),
}));

const { createFlow, pauseFlow, activateFlow } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000000aa";
const DONO = { userId: "dono-pausa", role: "owner" };
const comTime = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, DONO);
const sufixo = Math.random().toString(36).slice(2, 8);
const N1 = `pz-n1-${sufixo}`;
const N2 = `pz-n2-${sufixo}`;
const HORA = 3_600_000;

let flowId = "";
let contatos: string[] = [];

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Pausar e retomar (test)" } });
});

beforeEach(async () => {
  for (const f of Object.values(fila)) f.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  contatos = [];
  for (let i = 0; i < 6; i++) contatos.push((await basePrisma.contact.create({ data: { teamId: TEAM, nome: `Lead ${i}` } })).id);
  const f = await comTime(() =>
    createFlow({
      nome: "Pausa",
      triggerType: "manual",
      nodes: [
        { id: N1, tipo: "wait", config: { duration: 1, unit: "min" }, nextNodeId: N2 },
        { id: N2, tipo: "wait", config: { duration: 1, unit: "min" }, nextNodeId: null },
      ] as never,
    }),
  );
  flowId = f.id;
  await comTime(() => activateFlow(flowId));
  fila.acordarPasso.mockClear();
});

async function inscricao(i: number, dados: Record<string, unknown> = {}) {
  return basePrisma.enrollment.create({
    data: { teamId: TEAM, flowId, contactId: contatos[i]!, currentNodeId: N1, currentRound: 1, status: "waiting", nextRunAt: new Date(Date.now() + 8 * HORA), ...dados } as never,
  });
}
const estado = (id: string) => basePrisma.enrollment.findUniqueOrThrow({ where: { id } });
const passo = (enrollmentId: string, nodeId: string, round: number, result: unknown) =>
  basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId, nodeId, round, status: "done", result: result as never } });

describe("pausar segura na hora", () => {
  it("o caso do dono: passo adiado por 8 h vira 'pausado' e, ao ativar, roda de novo AGORA", async () => {
    const e = await inscricao(0, { currentRound: 2 });
    await passo(e.id, N1, 1, { nextNodeId: N1, deferred: true, motivo: "fora do horário de envio", delayMs: 8 * HORA });

    const p = await comTime(() => pauseFlow(flowId));
    expect(p).toMatchObject({ status: "paused", seguradas: 1 });
    expect(await estado(e.id)).toMatchObject({ status: "waiting", nextRunAt: null, waitingFor: "fluxo_pausado", waitingUntil: null, currentNodeId: N1, currentRound: 2 });

    const a = await comTime(() => activateFlow(flowId));
    expect(a).toMatchObject({ status: "active", retomadas: 1 });
    const depois = await estado(e.id);
    expect(depois).toMatchObject({ status: "active", waitingFor: null, currentNodeId: N1, currentRound: 2 });
    expect(depois.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(fila.acordarPasso).toHaveBeenCalledWith(e.id, N1, 2);
    expect(fila.scheduleStep).not.toHaveBeenCalled();
  });

  it("espera de verdade (passo Esperar): guarda o tempo que faltava e o respeita ao retomar", async () => {
    const e = await inscricao(1, { currentNodeId: N2, currentRound: 1, nextRunAt: new Date(Date.now() + 72 * HORA) });
    await passo(e.id, N1, 1, { nextNodeId: N2, delayMs: 72 * HORA }); // o passo anterior foi um Esperar (não adiou)

    const p = await comTime(() => pauseFlow(flowId));
    expect(p.seguradas).toBe(1);
    const parada = await estado(e.id);
    expect(parada).toMatchObject({ status: "waiting", nextRunAt: null, waitingFor: "fluxo_pausado" });
    expect(parada.waitingUntil!.getTime() - parada.updatedAt.getTime()).toBeGreaterThan(71 * HORA);

    // O fluxo ficou 2 horas pausado: faltavam 72 h na pausa, faltam 72 h na retomada (a pausa não conta).
    await basePrisma.enrollment.update({
      where: { id: e.id },
      data: { updatedAt: new Date(Date.now() - 2 * HORA), waitingUntil: new Date(Date.now() - 2 * HORA + 72 * HORA) } as never,
    });
    const a = await comTime(() => activateFlow(flowId));
    expect(a.retomadas).toBe(1);
    const depois = await estado(e.id);
    expect(depois).toMatchObject({ status: "waiting", waitingFor: null, waitingUntil: null });
    expect(depois.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 71 * HORA);
    expect(depois.nextRunAt!.getTime()).toBeLessThan(Date.now() + 73 * HORA);
    expect(fila.removeStepJob).toHaveBeenCalledWith(`${e.id}:${N2}:1`);
    expect(fila.scheduleStep).toHaveBeenCalledWith(e.id, N2, 1, expect.any(Number), expect.any(Number));
    expect((fila.scheduleStep.mock.calls[0]![3] as number) / HORA).toBeGreaterThan(71);
    expect(fila.acordarPasso).not.toHaveBeenCalled();
  });

  it("esperando resposta: segura e, ao ativar, o passo roda já (ele confere a resposta de novo)", async () => {
    const e = await inscricao(2, { waitingFor: "reply", waitingUntil: new Date(Date.now() + 5 * HORA) });
    await comTime(() => pauseFlow(flowId));
    expect(await estado(e.id)).toMatchObject({ waitingFor: "fluxo_pausado", waitingUntil: null, nextRunAt: null });
    await comTime(() => activateFlow(flowId));
    expect(await estado(e.id)).toMatchObject({ status: "active", waitingFor: null });
    expect(fila.acordarPasso).toHaveBeenCalledWith(e.id, N1, 1);
  });

  it("não mexe em DM na fila social, em inscrição encerrada nem em inscrição de outro fluxo", async () => {
    const social = await inscricao(3, { waitingFor: "social", nextRunAt: new Date(Date.now() + 30 * 60_000) });
    const feita = await inscricao(4, { status: "done", nextRunAt: null });
    const outro = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "Outro", triggerType: "manual", status: "active" } });
    const deOutro = await basePrisma.enrollment.create({
      data: { teamId: TEAM, flowId: outro.id, contactId: contatos[5]!, currentNodeId: N1, currentRound: 1, status: "waiting", nextRunAt: new Date(Date.now() + HORA) } as never,
    });

    const p = await comTime(() => pauseFlow(flowId));
    expect(p.seguradas).toBe(0);
    expect(await estado(social.id)).toMatchObject({ status: "waiting", waitingFor: "social" });
    expect(await estado(feita.id)).toMatchObject({ status: "done" });
    expect(await estado(deOutro.id)).toMatchObject({ waitingFor: null });
    expect(deOutro.nextRunAt).not.toBeNull();
  });

  it("pausar duas vezes não segura de novo nem perde o tempo guardado", async () => {
    const e = await inscricao(0, { currentNodeId: N2, nextRunAt: new Date(Date.now() + 10 * HORA) });
    await comTime(() => pauseFlow(flowId));
    const primeira = await estado(e.id);
    expect((await comTime(() => pauseFlow(flowId))).seguradas).toBe(0);
    expect((await estado(e.id)).waitingUntil?.getTime()).toBe(primeira.waitingUntil?.getTime());
  });

  it("ativar um fluxo que não estava pausado não retoma nada", async () => {
    await inscricao(0);
    expect((await comTime(() => activateFlow(flowId))).retomadas).toBe(0);
    expect(fila.acordarPasso).not.toHaveBeenCalled();
  });
});
