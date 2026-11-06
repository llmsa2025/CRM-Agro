import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Mensagem recebida VELHA (reentregue depois de uma queda) entra na conversa, mas não aciona automação:
 * sem inscrição em fluxo "mensagem recebida" e sem acordar quem espera resposta. Fila do motor mockada.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { receiveInbound, mensagemVelhaParaGatilho } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000000f9";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `inbound-velha-${sufixo}`;
const NUMERO = "5565988886666";
const HORA = 3_600_000;

let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Inbound velha (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
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
  await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = contato.id;
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true },
  });
  const flow = await basePrisma.flow.create({
    data: { teamId: TEAM, nome: "Respondeu", triggerType: "message_received", status: "active" },
  });
  await basePrisma.flowNode.create({
    data: { id: `mr-${flow.id}`, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function msg(id: string, haHoras: number) {
  const chegou = Date.now() - haHoras * HORA;
  return {
    entrada: {
      from: NUMERO,
      fromMe: false,
      text: "quero saber o preço",
      media: null,
      providerMessageId: id,
      timestamp: Math.floor(chegou / 1000),
      name: "Lead",
      instance: INSTANCIA,
    },
    recebidoEm: chegou,
  };
}

const inscricoes = () => basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: contatoId } });
const mensagens = (id: string) => basePrisma.message.count({ where: { teamId: TEAM, providerMessageId: id } });

describe("mensagem velha reentregue", () => {
  it("mensagem de 2 dias atrás: é gravada, mas não inscreve em fluxo nem agenda passo", async () => {
    const id = `WAMID-${sufixo}-velha`;
    const { entrada, recebidoEm } = msg(id, 48);
    await runWithTeam(TEAM, () => receiveInbound(entrada, { recebidoEm }));
    expect(await mensagens(id)).toBe(1);
    expect(await inscricoes()).toBe(0);
    expect(scheduleStep).not.toHaveBeenCalled();
  });

  it("mensagem de 1 hora atrás (queda curta): continua disparando o fluxo, como antes", async () => {
    const id = `WAMID-${sufixo}-curta`;
    const { entrada, recebidoEm } = msg(id, 1);
    await runWithTeam(TEAM, () => receiveInbound(entrada, { recebidoEm }));
    expect(await mensagens(id)).toBe(1);
    expect(await inscricoes()).toBe(1);
    expect(scheduleStep).toHaveBeenCalledTimes(1);
  });

  it("mensagem ao vivo: dispara o fluxo", async () => {
    const id = `WAMID-${sufixo}-viva`;
    const { entrada, recebidoEm } = msg(id, 0);
    await runWithTeam(TEAM, () => receiveInbound(entrada, { recebidoEm }));
    expect(await inscricoes()).toBe(1);
  });
});

describe("mensagemVelhaParaGatilho", () => {
  const agora = new Date("2026-10-12T12:00:00Z");
  const haHoras = (h: number) => new Date(agora.getTime() - h * HORA);

  it("usa 6 h por padrão: 5 h59 passa, 6 h01 é velha", () => {
    expect(mensagemVelhaParaGatilho(haHoras(5.98), agora)).toBe(false);
    expect(mensagemVelhaParaGatilho(haHoras(6.02), agora)).toBe(true);
  });

  it("respeita FLOW_STALE_HOURS e ignora valor inválido", () => {
    vi.stubEnv("FLOW_STALE_HOURS", "1");
    expect(mensagemVelhaParaGatilho(haHoras(2), agora)).toBe(true);
    expect(mensagemVelhaParaGatilho(haHoras(0.5), agora)).toBe(false);
    vi.stubEnv("FLOW_STALE_HOURS", "abc");
    expect(mensagemVelhaParaGatilho(haHoras(5), agora)).toBe(false);
    expect(mensagemVelhaParaGatilho(haHoras(7), agora)).toBe(true);
    vi.stubEnv("FLOW_STALE_HOURS", "0");
    expect(mensagemVelhaParaGatilho(haHoras(5), agora)).toBe(false);
  });

  it("mensagem do futuro (relógio adiantado) não é velha", () => {
    expect(mensagemVelhaParaGatilho(new Date(agora.getTime() + HORA), agora)).toBe(false);
  });
});
