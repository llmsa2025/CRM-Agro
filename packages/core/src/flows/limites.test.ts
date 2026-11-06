import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Limites anti-loop e anti-spam (item 1.4 — MF-08, MF-21). Fila e canal
 * MOCKADOS: nada vai ao Redis da fila nem sai mensagem de verdade.
 */
const scheduleStep = vi.fn(async () => {});
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => scheduleStep(...(a as [])),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));
// id do WhatsApp ÚNICO por envio (como a Evolution de verdade).
const canal = vi.hoisted(() => {
  let n = 0;
  return { send: vi.fn(async () => ({ providerMessageId: `WAMID-LIM-${Date.now()}-${n++}` })) };
});
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  const falso = { send: canal.send };
  return { ...real, getChannelProvider: () => falso, defaultEvolutionProvider: () => falso, hasWhatsAppHistory: async () => false };
});

const { reservarEnvioAoContato, devolverEnvioAoContato, encerrarPorLoop, MAX_ENVIOS_CONTATO_24H } = await import("./limites");
const { enrollByTrigger } = await import("./triggers");
const { enroll } = await import("./service");
const { executeNode } = await import("./executor");
const { InvalidGraphError } = await import("./errors");
const { moveDealInFunnel } = await import("../funnels/service");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM = "00000000-0000-0000-0000-0000000000c6";
const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
const uid = (p: string) => `${p}-${sufixo}-${seq++}`;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Limites (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  canal.send.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
});

async function contato() {
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  await redisEstado().del(`flow:contact:${c.id}:sends`);
  return c;
}

async function fluxo(triggerType: string, triggerConfig: Record<string, unknown> = {}) {
  const flow = await basePrisma.flow.create({
    data: { teamId: TEAM, nome: uid("F"), triggerType: triggerType as never, status: "active", triggerConfig: triggerConfig as never },
  });
  await basePrisma.flowNode.create({
    data: { id: uid("n"), teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never },
  });
  return flow;
}

const disparar = (tipo: string, payload: Record<string, unknown>) =>
  runWithTeam(TEAM, () => enrollByTrigger(tipo as never, payload as never));

describe("limite de envios por contato (3 em 24 h)", () => {
  it("a 4ª reserva é negada com a espera até zerar; devolver libera de novo", async () => {
    const c = await contato();
    for (let i = 0; i < MAX_ENVIOS_CONTATO_24H; i++) expect((await reservarEnvioAoContato(c.id)).ok).toBe(true);
    const negado = await reservarEnvioAoContato(c.id);
    expect(negado.ok).toBe(false);
    if (!negado.ok) expect(negado.esperaMs).toBeLessThanOrEqual(24 * 3600_000);
    await devolverEnvioAoContato(c.id);
    expect((await reservarEnvioAoContato(c.id)).ok).toBe(true);
  });

  it("auditoria do #64: chave que ficou SEM prazo (queda entre INCR e PEXPIRE) é curada — o contato não fica bloqueado para sempre", async () => {
    const contato = `sem-ttl-${Math.random().toString(36).slice(2, 8)}`;
    const k = `flow:contact:${contato}:sends`;
    await redisEstado().set(k, "3"); // estado que o bug deixava: no limite e sem TTL
    const r = await reservarEnvioAoContato(contato);
    expect(r.ok).toBe(false);
    const pttl = await redisEstado().pttl(k);
    expect(pttl).toBeGreaterThan(0); // agora expira: some em até 24 h
    expect(pttl).toBeLessThanOrEqual(24 * 3_600_000);
    await redisEstado().del(k);
  });

  it("devolver sem reserva não cria chave (nem '-1' sem prazo)", async () => {
    const contato = `sem-chave-${Math.random().toString(36).slice(2, 8)}`;
    await devolverEnvioAoContato(contato);
    expect(await redisEstado().exists(`flow:contact:${contato}:sends`)).toBe(0);
  });

  it("auditoria do #96: devolver com a chave em '0' não fica negativo nem perde o prazo", async () => {
    const contato = `zerada-${Math.random().toString(36).slice(2, 8)}`;
    const k = `flow:contact:${contato}:sends`;
    await redisEstado().set(k, "0", "PX", 60_000);
    await devolverEnvioAoContato(contato); // DECR → -1 → volta a "0" (ramo n < 0)
    expect(await redisEstado().get(k)).toBe("0");
    const pttl = await redisEstado().pttl(k);
    expect(pttl).toBeGreaterThan(0); // KEEPTTL: o prazo continua o mesmo
    expect(pttl).toBeLessThanOrEqual(60_000);
    // E o contador segue certo: ainda cabem as 3 reservas da janela.
    for (let i = 0; i < MAX_ENVIOS_CONTATO_24H; i++) expect((await reservarEnvioAoContato(contato)).ok).toBe(true);
    expect((await reservarEnvioAoContato(contato)).ok).toBe(false);
    await redisEstado().del(k);
  });

  it("send_message: o 4º envio automático ao MESMO contato é adiado sem chamar o canal", async () => {
    const c = await contato();
    const conta = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: uid("wa"), credentials: { instance: "x" }, status: "connected" },
    });
    await basePrisma.channelIdentifier.create({
      data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: "5565933332222", isPrimary: true },
    });
    const node = { id: "msg", tipo: "send_message", config: { text: "oi", channelAccountId: conta.id }, nextNodeId: null } as never;
    const ctx = { id: "e", teamId: TEAM, contactId: c.id, lastOutboundAt: null, contact: { id: c.id, nome: "Lead", tags: [], ownerId: null } };
    for (let i = 0; i < 3; i++) {
      expect((await runWithTeam(TEAM, () => executeNode(ctx, node))).deferred).toBeUndefined();
    }
    const quarto = await runWithTeam(TEAM, () => executeNode(ctx, node));
    expect(quarto).toMatchObject({ deferred: true, nextNodeId: "msg" });
    expect(quarto.motivo).toContain("por contato");
    expect(canal.send).toHaveBeenCalledTimes(3);
    const uso = await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: conta.id } });
    expect(uso?.sent).toBe(3); // a cota do número não foi tocada no 4º
  }, 30_000); // 4 envios completos na base de TESTE remota
});

describe("reentrada e exclusividade", () => {
  it("message_received: cooldown padrão de 24 h (anti pingue-pongue); depois volta a inscrever", async () => {
    const c = await contato();
    const f = await fluxo("message_received");
    await disparar("message_received", { contactId: c.id });
    await basePrisma.enrollment.updateMany({ where: { flowId: f.id }, data: { status: "done" } });
    await disparar("message_received", { contactId: c.id });
    expect(await basePrisma.enrollment.count({ where: { flowId: f.id } })).toBe(1);

    await basePrisma.enrollment.updateMany({ where: { flowId: f.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    await disparar("message_received", { contactId: c.id });
    expect(await basePrisma.enrollment.count({ where: { flowId: f.id } })).toBe(2);
  });

  it("reentry 'never' não reinscreve; 'always' no message_received reinscreve logo", async () => {
    const c = await contato();
    const nunca = await fluxo("contact_created", { reentry: "never" });
    const sempre = await fluxo("message_received", { reentry: "always" });
    for (const [tipo, f] of [["contact_created", nunca], ["message_received", sempre]] as const) {
      await disparar(tipo, { contactId: c.id });
      await basePrisma.enrollment.updateMany({ where: { flowId: f.id }, data: { status: "done" } });
      await disparar(tipo, { contactId: c.id });
    }
    expect(await basePrisma.enrollment.count({ where: { flowId: nunca.id } })).toBe(1);
    expect(await basePrisma.enrollment.count({ where: { flowId: sempre.id } })).toBe(2);
  });

  it("exclusivo: contato num fluxo exclusivo não entra em outro exclusivo; o comum entra", async () => {
    const c = await contato();
    const ex1 = await fluxo("contact_created", { exclusivo: true });
    const ex2 = await fluxo("contact_created", { exclusivo: true });
    const comum = await fluxo("contact_created");
    await disparar("contact_created", { contactId: c.id });
    const exclusivos = await basePrisma.enrollment.count({ where: { flowId: { in: [ex1.id, ex2.id] } } });
    expect(exclusivos).toBe(1);
    expect(await basePrisma.enrollment.count({ where: { flowId: comum.id } })).toBe(1);
  });
});

describe("cascata do motor (profundidade)", () => {
  it("gatilho na profundidade 3 não inscreve; na 2 inscreve e grava a profundidade", async () => {
    const c = await contato();
    const f = await fluxo("contact_created");
    await disparar("contact_created", { contactId: c.id, profundidade: 3 });
    expect(await basePrisma.enrollment.count({ where: { flowId: f.id } })).toBe(0);
    await disparar("contact_created", { contactId: c.id, profundidade: 2 });
    expect((await basePrisma.enrollment.findFirstOrThrow({ where: { flowId: f.id } })).profundidade).toBe(2);
  });

  it("mover etapa pelo motor passa profundidade + 1 ao stage_changed", async () => {
    const c = await contato();
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "F", tipo: "vendas" } });
    const e1 = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "A", ordem: 0 } });
    const e2 = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "B", ordem: 1 } });
    await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: e1.id, contactId: c.id, valor: 0 } });
    const f = await fluxo("stage_changed");
    await runWithTeam(TEAM, () => moveDealInFunnel(c.id, funil.id, e2.id, { profundidade: 1 }));
    expect((await basePrisma.enrollment.findFirstOrThrow({ where: { flowId: f.id } })).profundidade).toBe(1);
  });

  it("trocar de fluxo em ciclo para no limite", async () => {
    const c = await contato();
    const f = await fluxo("manual");
    await expect(runWithTeam(TEAM, () => enroll(c.id, f.id, { profundidade: 3 }))).rejects.toBeInstanceOf(InvalidGraphError);
  });
});

describe("teto de passos", () => {
  it("encerrarPorLoop marca a inscrição failed com o motivo no log do fluxo", async () => {
    const c = await contato();
    const f = await fluxo("manual");
    const enr = await basePrisma.enrollment.create({
      data: { teamId: TEAM, flowId: f.id, contactId: c.id, currentNodeId: "x", currentRound: 1, status: "active", stepNumber: 200 },
    });
    await runWithTeam(TEAM, () => encerrarPorLoop({ enrollmentId: enr.id, nodeId: "x", round: 1 }));
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).status).toBe("failed");
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p.error).toContain("loop");
  });
});
