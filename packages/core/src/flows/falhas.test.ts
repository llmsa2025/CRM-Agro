import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import type { JanelaEnvio } from "./janela";

/**
 * Retry de verdade nos envios (item 1.2 — MF-03/INT-03). O CANAL É MOCKADO:
 * nenhuma mensagem sai para a Evolution nem para contato real.
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

const canal = vi.hoisted(() => ({
  send: vi.fn(async () => ({ providerMessageId: "WAMID-FAKE" })),
  historico: vi.fn(async (): Promise<boolean | null> => false),
}));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  const falso = { send: canal.send };
  return {
    ...real,
    getChannelProvider: () => falso,
    defaultEvolutionProvider: () => falso,
    hasWhatsAppHistory: () => canal.historico(),
  };
});

const { ChannelSendFailed } = await import("@crmagro/channels");
const { tratarFalhaDoPasso, retomarPassoInterrompido, PREFIXO_NAO_SAIU, PREFIXO_CONSULTA } = await import("./falhas");
const { ConsultaWhatsAppIndisponivel } = await import("./errors");
const { executeNode } = await import("./executor");
const { updateTeamConfig } = await import("../motor-do-dia/team-config");

const TEAM = "00000000-0000-0000-0000-0000000000c4";
const sufixo = Math.random().toString(36).slice(2, 8);
const NUMERO = "5565944443333";

let contaId = "";
let contatoId = "";
let flowId = "";
const N1 = `f12-n1-${sufixo}`;
const N2 = `f12-n2-${sufixo}`;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Falhas (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  canal.send.mockReset();
  canal.send.mockImplementation(async () => ({ providerMessageId: "WAMID-FAKE" }));
  canal.historico.mockReset();
  canal.historico.mockImplementation(async () => false);
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const conta = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "whatsapp",
      label: "WA",
      provider: "evolution",
      externalId: `f12-${sufixo}`,
      credentials: { instance: `f12-${sufixo}` },
      status: "connected",
    },
  });
  contaId = conta.id;
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = contato.id;
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true },
  });
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "F", triggerType: "manual", status: "active" } });
  flowId = flow.id;
});

const noEnvio = { id: N1, tipo: "send_message", config: { text: "Oi {nome}" }, nextNodeId: N2 } as never;

async function passoRodando(round = 1, result?: unknown) {
  const enr =
    (await basePrisma.enrollment.findFirst({ where: { teamId: TEAM, flowId } })) ??
    (await basePrisma.enrollment.create({
      data: { teamId: TEAM, flowId, contactId: contatoId, currentNodeId: N1, currentRound: round, status: "active", nextRunAt: new Date() },
    }));
  await basePrisma.flowStepExecution.create({
    data: { teamId: TEAM, enrollmentId: enr.id, nodeId: N1, round, status: "running", ...(result ? { result: result as never } : {}) },
  });
  return enr;
}

const ctx = (enrId: string, round: number) => ({
  id: enrId,
  teamId: TEAM,
  contactId: contatoId,
  lastOutboundAt: null,
  round,
  contact: { id: contatoId, nome: "Lead", tags: [], ownerId: null },
});

async function usoDoDia() {
  const u = await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: contaId } });
  return u?.sent ?? 0;
}

describe("tratarFalhaDoPasso — decide pelo que se sabe do envio", () => {
  it("envio SAIU (marca 'enviado') e algo depois falhou → avança, não reenvia", async () => {
    const enr = await passoRodando(1, { fase: "enviado", enviado: true, providerMessageId: "X" });
    const d = await runWithTeam(TEAM, () =>
      tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, erro: new Error("P2024 pool") }),
    );
    expect(d).toBe("avancou");
    expect(scheduleStep).toHaveBeenCalledWith(enr.id, N2, 1, undefined);
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).toMatchObject({ currentNodeId: N2 });
  });

  it("resultado INCERTO (timeout depois de enviar) → segura para revisão", async () => {
    const enr = await passoRodando();
    const d = await runWithTeam(TEAM, () =>
      tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, erro: new ChannelSendFailed("timeout", "unknown", false) }),
    );
    expect(d).toBe("segurado");
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).toMatchObject({ status: "waiting", nextRunAt: null });
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p.status).toBe("failed");
    expect(p.error).toContain("resultado incerto");
    expect(scheduleStep).not.toHaveBeenCalled();
  });

  it("impossível (número inválido, 4xx) → pula o passo com o motivo e segue", async () => {
    const enr = await passoRodando();
    const d = await runWithTeam(TEAM, () =>
      tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, erro: new ChannelSendFailed("400 numero invalido", "not_sent", false) }),
    );
    expect(d).toBe("pulado");
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p).toMatchObject({ status: "skipped" });
    expect(p.error).toContain("numero invalido");
    expect(scheduleStep).toHaveBeenCalledWith(enr.id, N2, 1, undefined);
  });

  const recusaDaEvolution = (numero: string) =>
    new ChannelSendFailed(
      `Evolution sendText 400: {"status":400,"error":"Bad Request","response":{"message":[{"jid":"${numero}@s.whatsapp.net","exists":false,"number":"${numero}"}]}}`,
      "not_sent",
      false,
      400,
    );

  it("número sem WhatsApp (Evolution 400 exists:false) → pula com texto em português e marca o número no cadastro", async () => {
    const enr = await passoRodando();
    const d = await runWithTeam(TEAM, () =>
      tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, erro: recusaDaEvolution(NUMERO) }),
    );
    expect(d).toBe("pulado");
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p).toMatchObject({ status: "skipped", error: "Número sem WhatsApp: +55 65 94444-3333. Passo pulado. Número marcado no cadastro." });
    const idt = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: contatoId, canal: "whatsapp" } });
    expect(idt.invalido).toBe(true);
    expect(idt.invalidoMotivo).toMatch(/^sem WhatsApp \(o WhatsApp recusou o envio em \d{4}-\d{2}-\d{2}\)$/);
    expect(scheduleStep).toHaveBeenCalledWith(enr.id, N2, 1, undefined);
  });

  it("recusa de um número que o contato não tem no cadastro: pula do mesmo jeito e não marca nada", async () => {
    const enr = await passoRodando();
    await runWithTeam(TEAM, () =>
      tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, erro: recusaDaEvolution("5566900000000") }),
    );
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p.error).toBe("Número sem WhatsApp: +55 66 90000-0000. Passo pulado.");
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: contatoId, canal: "whatsapp" } })).invalido).toBe(false);
  });

  it("Evolution fora (não saiu, vale repetir) → mesmo nó com backoff 5/15/60 min; na 4ª, failed", async () => {
    const enr = await passoRodando();
    const erro = new ChannelSendFailed("ECONNREFUSED", "not_sent", true);
    const esperado = [5, 15, 60];
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const round = tentativa + 1;
      if (tentativa > 0) await passoRodando(round);
      scheduleStep.mockClear();
      const d = await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round, node: noEnvio, erro }));
      expect(d).toBe("reagendado");
      // 5/15/60 min com ±20% de jitter (lote de falhas não volta todo junto).
      const atraso = (scheduleStep.mock.calls[0] as unknown as [string, string, number, number])[3];
      expect(scheduleStep).toHaveBeenCalledWith(enr.id, N1, round + 1, expect.any(Number));
      expect(atraso).toBeGreaterThanOrEqual(esperado[tentativa]! * 60_000 * 0.8);
      expect(atraso).toBeLessThanOrEqual(esperado[tentativa]! * 60_000 * 1.2);
    }
    await passoRodando(4);
    const d = await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 4, node: noEnvio, erro }));
    expect(d).toBe("falhou");
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).status).toBe("failed");
    expect(await basePrisma.flowStepExecution.count({ where: { enrollmentId: enr.id, error: { startsWith: PREFIXO_NAO_SAIU } } })).toBe(4);
  });

  it("condição 'Tem WhatsApp' conferindo no WhatsApp sem resposta → repete 5/15/60 min e, na 4ª, SEGURA para revisão (não falha nem escolhe ramo)", async () => {
    const noCondicao = { id: N1, tipo: "condition", branches: { branches: [], default: null } } as never;
    const enr = await passoRodando();
    const erro = new ConsultaWhatsAppIndisponivel("o WhatsApp não respondeu");
    const esperado = [5, 15, 60];
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const round = tentativa + 1;
      if (tentativa > 0) await passoRodando(round);
      scheduleStep.mockClear();
      const d = await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round, node: noCondicao, erro }));
      expect(d).toBe("reagendado");
      const atraso = (scheduleStep.mock.calls[0] as unknown as [string, string, number, number])[3];
      expect(scheduleStep).toHaveBeenCalledWith(enr.id, N1, round + 1, expect.any(Number));
      expect(atraso).toBeGreaterThanOrEqual(esperado[tentativa]! * 60_000 * 0.8);
      expect(atraso).toBeLessThanOrEqual(esperado[tentativa]! * 60_000 * 1.2);
    }
    await passoRodando(4);
    scheduleStep.mockClear();
    const d = await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 4, node: noCondicao, erro }));
    expect(d).toBe("segurado");
    expect(scheduleStep).not.toHaveBeenCalled();
    // Segurada para revisão, no passo certo: waiting, sem próxima execução, e NÃO `failed`.
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: enr.id } })).toMatchObject({ status: "waiting", nextRunAt: null, currentNodeId: N1, currentRound: 4 });
    const ultimo = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id, round: 4 } });
    expect(ultimo.status).toBe("failed");
    expect(ultimo.error).toMatch(/^Não deu para conferir o número no WhatsApp \(o WhatsApp não respondeu\) depois de 4 tentativas\./);
    expect(ultimo.error).toContain("devolva o contato a este mesmo passo");
    // As três primeiras ficam no log com o texto da consulta (e não falam em "envio").
    expect(await basePrisma.flowStepExecution.count({ where: { enrollmentId: enr.id, error: { startsWith: PREFIXO_CONSULTA } } })).toBe(3);
    expect(await basePrisma.flowStepExecution.count({ where: { enrollmentId: enr.id, error: { startsWith: PREFIXO_NAO_SAIU } } })).toBe(0);

    // Depois de segurada, a pessoa devolve o contato ao MESMO passo (Histórico) e a Evolution falha de novo:
    // a contagem recomeça (repete em 5 min), não segura na primeira falha.
    await passoRodando(5);
    scheduleStep.mockClear();
    const depois = await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 5, node: noCondicao, erro }));
    expect(depois).toBe("reagendado");
    const atraso = (scheduleStep.mock.calls[0] as unknown as [string, string, number, number])[3];
    expect(atraso).toBeGreaterThanOrEqual(5 * 60_000 * 0.8);
    expect(atraso).toBeLessThanOrEqual(5 * 60_000 * 1.2);
  });

  it("caiu DURANTE o envio (marca 'enviando', erro comum) → segura; sem marca → relança para o retry", async () => {
    const enr = await passoRodando(1, { fase: "enviando" });
    expect(
      await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, erro: new Error("socket hang up") })),
    ).toBe("segurado");

    await passoRodando(2);
    expect(
      await runWithTeam(TEAM, () => tratarFalhaDoPasso({ enrollmentId: enr.id, nodeId: N1, round: 2, node: noEnvio, erro: new Error("P2024 pool") })),
    ).toBe("relancar");
    // Claim liberado: o retry do BullMQ refaz o passo do zero.
    expect(await basePrisma.flowStepExecution.count({ where: { enrollmentId: enr.id, round: 2 } })).toBe(0);
  });

  it("processo caiu no meio (retry acha 'running'): a marca decide", async () => {
    const enr = await passoRodando(1, { fase: "enviado", enviado: true });
    expect(await runWithTeam(TEAM, () => retomarPassoInterrompido({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, result: { fase: "enviado", enviado: true } }))).toBe(true);
    expect(scheduleStep).toHaveBeenCalledWith(enr.id, N2, 1, undefined);
    // sem marca: seguro refazer
    expect(await runWithTeam(TEAM, () => retomarPassoInterrompido({ enrollmentId: enr.id, nodeId: N1, round: 1, node: noEnvio, result: null }))).toBe(false);
  });
});

describe("send_message — cota e marcas em volta do canal", () => {
  it("envio ok grava 'enviado' com o id do WhatsApp; gasta 1 da cota", async () => {
    const enr = await passoRodando();
    const r = await runWithTeam(TEAM, () => executeNode(ctx(enr.id, 1), noEnvio));
    expect(r.nextNodeId).toBe(N2);
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p.result).toMatchObject({ fase: "enviado", enviado: true, providerMessageId: "WAMID-FAKE" });
    expect(await usoDoDia()).toBe(1);
  });

  it("canal recusou (não saiu) → cota DEVOLVIDA e o erro sobe classificado", async () => {
    canal.send.mockImplementation(async () => {
      throw new ChannelSendFailed("Evolution 503", "not_sent", true, 503);
    });
    const enr = await passoRodando();
    const e = await runWithTeam(TEAM, () => executeNode(ctx(enr.id, 1), noEnvio)).catch((x) => x);
    expect(e).toMatchObject({ name: "ChannelSendFailed", outcome: "not_sent" });
    expect(await usoDoDia()).toBe(0);
    const p = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enr.id } });
    expect(p.result).toMatchObject({ fase: "enviando" });
  });

  it("timeout depois de enviar (incerto) → cota NÃO volta (pode ter saído)", async () => {
    canal.send.mockImplementation(async () => {
      throw new ChannelSendFailed("timeout", "unknown", false);
    });
    const enr = await passoRodando();
    await runWithTeam(TEAM, () => executeNode(ctx(enr.id, 1), noEnvio)).catch(() => {});
    expect(await usoDoDia()).toBe(1);
  });

  it("contato sem WhatsApp → pula SEM gastar cota nem chamar o canal", async () => {
    await basePrisma.channelIdentifier.deleteMany({ where: { contactId: contatoId } });
    const enr = await passoRodando();
    const r = await runWithTeam(TEAM, () => executeNode(ctx(enr.id, 1), noEnvio));
    expect(r).toMatchObject({ nextNodeId: N2, skipped: true, motivo: "contato sem WhatsApp" });
    expect(canal.send).not.toHaveBeenCalled();
    expect(await usoDoDia()).toBe(0);
  });

  it("histórico indisponível: 'hold' segura; 'skip' adia 15 min — nunca envia no escuro", async () => {
    canal.historico.mockImplementation(async () => null);
    const enr = await passoRodando();
    const hold = await runWithTeam(TEAM, () =>
      executeNode(ctx(enr.id, 1), { ...(noEnvio as object), config: { text: "x", skipIfHistory: true, onHistory: "hold" } } as never),
    );
    expect(hold).toMatchObject({ hold: true });
    const skip = await runWithTeam(TEAM, () =>
      executeNode(ctx(enr.id, 1), { ...(noEnvio as object), config: { text: "x", skipIfHistory: true } } as never),
    );
    expect(skip).toMatchObject({ deferred: true, delayMs: 15 * 60_000 });
    expect(canal.send).not.toHaveBeenCalled();
  });
});

describe("janela de envio e cota (item 1.3)", () => {
  const SABADO_2H = new Date("2026-09-26T02:00:00-03:00");
  const comRelogio = async (fn: () => Promise<void>) => {
    process.env.FLOW_JANELA_ENVIO = "on";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SABADO_2H);
    try {
      await fn();
    } finally {
      vi.useRealTimers();
      process.env.FLOW_JANELA_ENVIO = "off";
      await runWithTeam(TEAM, () => updateTeamConfig({ respectBusinessHours: false }), { userId: "dono", role: "owner" });
    }
  };
  const ligarHorarioDaEmpresa = () => runWithTeam(TEAM, () => updateTeamConfig({ respectBusinessHours: true }), { userId: "dono", role: "owner" });

  it("sábado de madrugada: o passo é ADIADO para a abertura — canal não é chamado, cota intacta", async () => {
    await ligarHorarioDaEmpresa();
    await comRelogio(async () => {
      const enr = await passoRodando();
      const r = await runWithTeam(TEAM, () => executeNode(ctx(enr.id, 1), noEnvio));
      expect(r).toMatchObject({ nextNodeId: N1, deferred: true, motivo: "fora do horário de envio" });
      expect(r.delayMs!).toBeGreaterThan(50 * 3600_000); // até segunda 08:00
      expect(canal.send).not.toHaveBeenCalled();
      expect(await usoDoDia()).toBe(0);
    });
  });

  it("empresa com o horário comercial DESLIGADO (o botão da tela): o fluxo envia a qualquer hora", async () => {
    await runWithTeam(TEAM, () => updateTeamConfig({ respectBusinessHours: false }), { userId: "dono", role: "owner" });
    await comRelogio(async () => {
      const enr = await passoRodando();
      const r = await runWithTeam(TEAM, () => executeNode(ctx(enr.id, 1), noEnvio));
      expect(r.deferred).toBeUndefined();
      expect(canal.send).toHaveBeenCalledTimes(1);
    });
  });

  it("fluxo 'qualquer hora' envia mesmo com o horário da empresa ligado", async () => {
    await ligarHorarioDaEmpresa();
    await comRelogio(async () => {
      const enr = await passoRodando();
      const r = await runWithTeam(TEAM, () => executeNode({ ...ctx(enr.id, 1), janelaEnvio: { modo: "livre" } }, noEnvio));
      expect(r.deferred).toBeUndefined();
      expect(canal.send).toHaveBeenCalledTimes(1);
    });
  });

  it("fluxo com horário PRÓPRIO segura fora dele, mesmo com o horário da empresa desligado", async () => {
    await runWithTeam(TEAM, () => updateTeamConfig({ respectBusinessHours: false }), { userId: "dono", role: "owner" });
    await comRelogio(async () => {
      const enr = await passoRodando();
      const propria: JanelaEnvio = { modo: "propria", abertura: "09:00", fechamento: "17:00", dias: ["mon", "tue", "wed", "thu", "fri"], feriados: true };
      const r = await runWithTeam(TEAM, () => executeNode({ ...ctx(enr.id, 1), janelaEnvio: propria }, noEnvio));
      expect(r).toMatchObject({ deferred: true, motivo: "fora do horário de envio" });
      expect(r.delayMs!).toBeGreaterThan(50 * 3600_000); // até segunda 09:00
      expect(canal.send).not.toHaveBeenCalled();
    });
  });

  it("primeiro envio do dia em paralelo: sem P2002 na cota (MF-06), cada um conta 1", async () => {
    const { consumeSendQuota } = await import("../channels-limit/service");
    const r = await runWithTeam(TEAM, () => Promise.all([1, 2, 3, 4, 5].map(() => consumeSendQuota(contaId))));
    expect(r.every((x) => x.allowed)).toBe(true);
    expect(await usoDoDia()).toBe(5);
  });
});
