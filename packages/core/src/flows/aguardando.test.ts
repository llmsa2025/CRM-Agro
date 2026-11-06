import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Espera por resposta orientada a evento (item 1.1, MF-02): a mensagem
 * recebida acorda a inscrição NA HORA (promove o job de timeout), sem poll.
 * Fila mockada — nada vai ao Redis nem é enviado.
 */
const acordarPasso = vi.fn(async () => {});
const scheduleStep = vi.fn(async () => {});
vi.mock("./queue", () => ({
  acordarPasso: (...a: unknown[]) => acordarPasso(...(a as [])),
  scheduleStep: (...a: unknown[]) => scheduleStep(...(a as [])),
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { concluirPasso } = await import("./avanco");
const { acordarQuemEsperaResposta } = await import("./aguardando");
const { receiveInbound } = await import("../conversations/service");

const TEAM = "00000000-0000-0000-0000-0000000000c3";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `aguardando-${sufixo}`;
const NUMERO = "5565955554444";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Aguardando (test)" } });
});

beforeEach(async () => {
  acordarPasso.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
});

/** Inscrição parada na condição "respondeu?" (como o handler deixaria). */
async function esperandoResposta() {
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "F", triggerType: "manual", status: "active" } });
  const nodeId = `cond-${flow.id}`;
  await basePrisma.flowNode.create({
    data: { id: nodeId, teamId: TEAM, flowId: flow.id, tipo: "condition" as never, config: {} as never },
  });
  const enr = await basePrisma.enrollment.create({
    data: { teamId: TEAM, flowId: flow.id, contactId: contato.id, currentNodeId: nodeId, currentRound: 1, status: "active", nextRunAt: new Date() },
  });
  await basePrisma.flowStepExecution.create({
    data: { teamId: TEAM, enrollmentId: enr.id, nodeId, round: 1, status: "running" },
  });
  const ate = new Date(Date.now() + 3600_000);
  const prox = await runWithTeam(TEAM, () =>
    concluirPasso({
      enrollmentId: enr.id,
      nodeId,
      round: 1,
      result: { nextNodeId: nodeId, delayMs: 3600_000, aguardandoResposta: { ate } },
    }),
  );
  return { contato, enr, nodeId, prox, ate };
}

describe("espera por resposta (item 1.1)", () => {
  it("a condição sem resposta marca waitingFor=reply até o fim da janela, com UM job", async () => {
    const { enr, nodeId, prox, ate } = await esperandoResposta();
    expect(prox).toEqual({ nodeId, round: 2, delayMs: 3600_000 });
    const e = await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } });
    expect(e).toMatchObject({ status: "waiting", waitingFor: "reply", currentRound: 2 });
    expect(e.waitingUntil?.getTime()).toBe(ate.getTime());
  });

  it("mensagem recebida acorda NA HORA (promove o job do round devido) e limpa a marca", async () => {
    const { contato, enr, nodeId } = await esperandoResposta();
    const conta = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
    });
    await basePrisma.channelIdentifier.create({
      data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true },
    });
    const t0 = Date.now();
    await receiveInbound({
      from: NUMERO,
      fromMe: false,
      text: "tenho interesse",
      media: null,
      providerMessageId: `AG-${sufixo}`,
      timestamp: null,
      name: "Lead",
      instance: conta.externalId,
    });
    expect(acordarPasso).toHaveBeenCalledWith(enr.id, nodeId, 2);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const e = await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } });
    expect(e).toMatchObject({ status: "active", waitingFor: null });
  });

  it("duas mensagens seguidas acordam uma vez só", async () => {
    const { contato } = await esperandoResposta();
    const n1 = await runWithTeam(TEAM, () => acordarQuemEsperaResposta(contato.id));
    const n2 = await runWithTeam(TEAM, () => acordarQuemEsperaResposta(contato.id));
    expect([n1, n2]).toEqual([1, 0]);
    expect(acordarPasso).toHaveBeenCalledTimes(1);
  });

  it("passo que não espera resposta limpa a marca", async () => {
    const { enr, nodeId } = await esperandoResposta();
    await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: enr.id, nodeId, round: 2, status: "running" } });
    await runWithTeam(TEAM, () => concluirPasso({ enrollmentId: enr.id, nodeId, round: 2, result: { nextNodeId: null } }));
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).toMatchObject({
      status: "done",
      waitingFor: null,
      waitingUntil: null,
    });
  });
});
