import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { parseEvolutionInbound } from "@crmagro/channels";
import { runWithTeam } from "../test-support/identidade";

/**
 * Mensagem recebida nunca se perde nem duplica (auditoria INT-01, INT-02,
 * INT-16, INT-17 — item 0.8). Fila do motor mockada: o gatilho
 * message_received não envia nada de verdade.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { receiveInbound, dataDaMensagem } = await import("./service");
const { acceptWhatsAppWebhook, inboundJobId } = await import("./inbound-queue");
const { vincularConversaAoContato } = await import("./vinculo");
const { mergeContacts } = await import("../contacts/service");

const TEAM = "00000000-0000-0000-0000-0000000000fd";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `inbound-teste-${sufixo}`;
const NUMERO = "5565988887777";

let contaId = "";
let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Inbound (test)" } });
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
  const conta = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
  contaId = conta.id;
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = contato.id;
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true },
  });
});

function msg(id: string, extra: Partial<Parameters<typeof receiveInbound>[0]> = {}) {
  return {
    from: NUMERO,
    fromMe: false,
    text: "quero saber o preço",
    media: null,
    providerMessageId: id,
    timestamp: null,
    name: "Lead",
    instance: INSTANCIA,
    ...extra,
  };
}

async function fluxoMensagemRecebida() {
  const flow = await basePrisma.flow.create({
    data: { teamId: TEAM, nome: "Respondeu", triggerType: "message_received", status: "active" },
  });
  await basePrisma.flowNode.create({
    data: { id: `mr-${flow.id}`, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never },
  });
  return flow;
}

describe("receiveInbound — idempotente", () => {
  it("a mesma mensagem 2× → 1 Message, 1 Activity, 1 inscrição de fluxo", async () => {
    await fluxoMensagemRecebida();
    const id = `WAMID-${sufixo}-1`;
    await receiveInbound(msg(id));
    await receiveInbound(msg(id));
    expect(await basePrisma.message.count({ where: { teamId: TEAM, providerMessageId: id } })).toBe(1);
    expect(await basePrisma.activity.count({ where: { teamId: TEAM, contactId: contatoId } })).toBe(1);
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: contatoId } })).toBe(1);
    expect(scheduleStep).toHaveBeenCalledTimes(1);
  });

  it("entregas SIMULTÂNEAS da mesma mensagem → uma só gravada (índice único)", async () => {
    const id = `WAMID-${sufixo}-2`;
    await Promise.all([receiveInbound(msg(id)), receiveInbound(msg(id)), receiveInbound(msg(id))]);
    expect(await basePrisma.message.count({ where: { teamId: TEAM, providerMessageId: id } })).toBe(1);
    expect(await basePrisma.activity.count({ where: { teamId: TEAM, contactId: contatoId } })).toBe(1);
  });

  it("primeiro contato de número NÃO cadastrado, em rajada → uma conversa só", async () => {
    const numeroNovo = "5565977776666";
    await Promise.all(
      [1, 2, 3].map((i) => receiveInbound(msg(`WAMID-${sufixo}-n${i}`, { from: numeroNovo }))),
    );
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM, externalNumber: numeroNovo } })).toBe(1);
    expect(await basePrisma.message.count({ where: { teamId: TEAM, conversation: { externalNumber: numeroNovo } } })).toBe(3);
  });

  it("hora da mensagem = timestamp do WhatsApp (não a hora da ingestão)", async () => {
    const ts = Math.floor(Date.now() / 1000) - 3600; // mandada há 1 h, chegou agora
    await receiveInbound(msg(`WAMID-${sufixo}-ts`, { timestamp: ts }));
    const m = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, providerMessageId: `WAMID-${sufixo}-ts` } });
    // Chegou bem depois: fim do segundo do timestamp (ver dataDaMensagem, 3.3).
    expect(m.createdAt.getTime()).toBe(ts * 1000 + 999);
    const conv = await basePrisma.conversation.findUniqueOrThrow({ where: { id: m.conversationId } });
    expect(conv.lastMessageAt?.getTime()).toBe(ts * 1000 + 999);
    // Relógio do aparelho no futuro → hora de agora.
    const agora = new Date("2026-09-26T12:00:00Z");
    expect(dataDaMensagem(agora.getTime() / 1000 + 3600, agora)).toEqual(agora);
  });
});

describe("webhook → fila", () => {
  const corpo = {
    event: "messages.upsert",
    instance: INSTANCIA,
    data: { key: { remoteJid: `${NUMERO}@s.whatsapp.net`, id: "ABC123", fromMe: false }, message: { conversation: "oi" } },
  };

  it("Redis fora (fila não aceita) → 503 para a Evolution reenviar", async () => {
    const r = await acceptWhatsAppWebhook(corpo, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r.status).toBe(503);
  });

  it("fila aceitou → 200; recibo também vai para a fila", async () => {
    const jobs: unknown[] = [];
    const enq = async (j: unknown) => void jobs.push(j);
    expect((await acceptWhatsAppWebhook(corpo, enq)).status).toBe(200);
    const recibo = {
      event: "messages.update",
      instance: INSTANCIA,
      data: { keyId: "ABC123", status: "READ", remoteJid: `${NUMERO}@s.whatsapp.net`, fromMe: true },
    };
    const r = await acceptWhatsAppWebhook(recibo, enq);
    expect(r.status).toBe(200);
    expect(jobs.map((j) => (j as { kind: string }).kind)).toContain("message");
  });

  it("jobId determinístico e sem ':' (o BullMQ recusa ':')", () => {
    const job = { kind: "message" as const, msg: msg("XYZ") };
    expect(inboundJobId(job)).toBe(inboundJobId(job));
    expect(inboundJobId(job)).not.toContain(":");
  });
});

describe("parser (INT-17)", () => {
  const base = (message: unknown, key: Record<string, unknown> = {}) => ({
    instance: "i",
    data: { key: { remoteJid: `${NUMERO}@s.whatsapp.net`, id: "X", ...key }, message, messageTimestamp: "1790000000" },
  });

  it("desembrulha temporária, visualização única e documento com legenda", () => {
    expect(parseEvolutionInbound(base({ ephemeralMessage: { message: { conversation: "sumiu?" } } }))?.text).toBe("sumiu?");
    expect(
      parseEvolutionInbound(base({ viewOnceMessageV2: { message: { imageMessage: { caption: "olha", mimetype: "image/jpeg" } } } }))
        ?.media?.kind,
    ).toBe("image");
    const doc = parseEvolutionInbound(
      base({ documentWithCaptionMessage: { message: { documentMessage: { caption: "proposta", mimetype: "application/pdf" } } } }),
    );
    expect(doc?.text).toBe("proposta");
    expect(doc?.media?.kind).toBe("doc");
  });

  it("localização, contato e figurinha viram texto; timestamp em texto é aceito", () => {
    const loc = parseEvolutionInbound(base({ locationMessage: { degreesLatitude: -15.6, degreesLongitude: -56.1, name: "Fazenda" } }));
    expect(loc?.text).toBe("[localização] -15.6,-56.1 (Fazenda)");
    expect(loc?.timestamp).toBe(1790000000);
    expect(parseEvolutionInbound(base({ contactMessage: { displayName: "João" } }))?.text).toBe("[contato] João");
    expect(parseEvolutionInbound(base({ stickerMessage: {} }))?.text).toBe("[figurinha]");
  });

  it("@lid usa o número alternativo; sem alternativo, descarta (não inventa contato)", () => {
    const comAlt = parseEvolutionInbound(
      base({ conversation: "oi" }, { remoteJid: "123456789012345@lid", remoteJidAlt: `${NUMERO}@s.whatsapp.net` }),
    );
    expect(comAlt?.from).toContain("65988887777");
    expect(parseEvolutionInbound(base({ conversation: "oi" }, { remoteJid: "123456789012345@lid" }))).toBeNull();
  });
});

describe("conversa única por conta (vínculo e unificação)", () => {
  it("vincular conversa de número a contato que já tem conversa → mescla", async () => {
    const dele = await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, contactId: contatoId, status: "open" },
    });
    const solta = await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: "5565911112222", status: "open", unreadCount: 2 },
    });
    await basePrisma.message.create({
      data: { teamId: TEAM, conversationId: solta.id, direcao: "in", tipo: "text", conteudo: "antes do cadastro", status: "delivered" },
    });
    const ficou = await runWithTeam(TEAM, () => vincularConversaAoContato(solta.id, contatoId));
    expect(ficou).toBe(dele.id);
    expect(await basePrisma.conversation.findUnique({ where: { id: solta.id } })).toBeNull();
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(1);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: dele.id } })).unreadCount).toBe(2);
  });

  it("unificar contatos com conversa na MESMA conta não quebra no índice", async () => {
    const outro = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead (dup)" } });
    for (const c of [contatoId, outro.id]) {
      const conv = await basePrisma.conversation.create({
        data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, contactId: c, status: "open" },
      });
      await basePrisma.message.create({
        data: { teamId: TEAM, conversationId: conv.id, direcao: "in", tipo: "text", conteudo: `de ${c}`, status: "delivered" },
      });
    }
    await runWithTeam(TEAM, () => mergeContacts(contatoId, [outro.id]));
    const convs = await basePrisma.conversation.findMany({ where: { teamId: TEAM, contactId: contatoId } });
    expect(convs).toHaveLength(1);
    expect(await basePrisma.message.count({ where: { conversationId: convs[0]!.id } })).toBe(2);
  });
});
