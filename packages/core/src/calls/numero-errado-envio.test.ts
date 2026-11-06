import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import { zonedTimeToUtc } from "../motor-do-dia/tz";

/**
 * Número errado (produto §D) no ENVIO e no discador (auditoria do #130):
 * marcado o primário como errado, a campanha e o envio saem pelo OUTRO número
 * válido do contato, e o discador não oferece mais o número errado. O canal é
 * FALSO (nada sai para o WhatsApp); fila e checagem de WhatsApp mockadas.
 */
const enviados: Array<{ to: string }> = [];
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => ({
    send: async (input: { to: string }) => {
      enviados.push({ to: input.to });
      return { providerMessageId: `ERRADO-${enviados.length}-${Math.random().toString(36).slice(2, 8)}` };
    },
  }),
}));
vi.mock("../conversations/service", async (original) => ({
  ...(await original<typeof import("../conversations/service")>()),
  sendTyping: async () => {},
}));
vi.mock("../campaigns/queue", () => ({
  agendarTick: async () => {},
  agendarMontagemDaLista: async () => {},
  getCampaignQueue: () => ({}),
}));
vi.mock("../campaigns/tem-whatsapp", () => ({
  temWhatsApp: async (numeros: string[]) => new Map(numeros.map((n) => [n, { existe: null, nome: null }])),
}));

const { createManualCall, finishManualCall } = await import("./service");
const { markCallOutcome, getNextDialerSlot } = await import("./dialer");
const { createCampaign, prepararLista, montarLista } = await import("../campaigns/service");
const { processarTickDaCampanha } = await import("../campaigns/tick");

const TEAM = "00000000-0000-0000-0000-0000000005a3";
const X = "+5565999000531"; // primário, dado como errado
const Y = "+5565999000532"; // o outro número, válido
const sufixo = Math.random().toString(36).slice(2, 8);
/** Segunda, 28/09/2026, 09:00 em Brasília (dentro da janela da campanha). */
const SEGUNDA_9H = zonedTimeToUtc(2026, 9, 28, 9, 0, "America/Sao_Paulo");
let contaId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team número errado envio (test)" } });
});

beforeEach(async () => {
  enviados.length = 0;
  const w = { teamId: TEAM };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await redisEstado().del(`flow:balde:${TEAM}`);
  const conta = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "whatsapp",
      label: "WA",
      provider: "evolution",
      externalId: `errado-${sufixo}`,
      status: "connected",
      credentials: { instance: `errado-${sufixo}` },
      dailyLimit: 400,
    },
  });
  contaId = conta.id;
});

/** Contato com X (primário) e, opcionalmente, Y. */
async function contato(nome: string, comY = true) {
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome } });
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: X, isPrimary: true } });
  if (comY) {
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: Y, isPrimary: false } });
  }
  await redisEstado().del(`flow:contact:${c.id}:sends`);
  return c;
}

/** "Dia seguinte" para o discador: a ligação de hoje passa a ser de ontem. */
const paraOntem = (callId: string) =>
  basePrisma.call.update({ where: { id: callId }, data: { createdAt: new Date(Date.now() - 86_400_000) } });

describe("campanha depois do número errado", () => {
  it("a lista escolhe o número válido e o envio sai por ele — nunca pelo primário errado", async () => {
    const c = await contato("Ana");
    const { callId } = await runWithTeam(TEAM, () => createManualCall({ phoneNumber: X, contactId: c.id }));
    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "wrong_number" }));

    const camp = await runWithTeam(TEAM, () => createCampaign("Depois do número errado"));
    const { versao } = await runWithTeam(TEAM, () => prepararLista(camp.id, { tipo: "filtro", contactIds: [c.id] }));
    const resumo = await runWithTeam(TEAM, () => montarLista(camp.id, versao, { historico: async () => false }));
    expect(resumo).toMatchObject({ fila: 1, semWhatsApp: 0 });
    const r = await basePrisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: camp.id } });
    expect(r).toMatchObject({ status: "queued", telefone: Y });

    // Liga a campanha e roda um tick com o canal falso.
    await basePrisma.campaign.update({
      where: { id: camp.id },
      data: { status: "sending", tickToken: "tok-errado", channelAccountId: contaId, mensagem: "Oi, {primeiro_nome|tudo bem}?" },
    });
    const job = { kind: "tick" as const, teamId: TEAM, campaignId: camp.id, token: "tok-errado", seq: 0 };
    const res = await runWithTeam(TEAM, () => processarTickDaCampanha(job, { agora: SEGUNDA_9H, aleatorio: () => 0 }), {
      userId: "sistema",
      role: "owner",
    });
    expect(res).toBe("enviado");
    expect(enviados.map((e) => e.to)).toEqual([Y]);
  });
});

describe("discador depois do número errado", () => {
  it("no dia seguinte oferece o outro número; com só o número errado, não oferece o contato", async () => {
    const dois = await contato("Bia");
    const s1 = await runWithTeam(TEAM, () => getNextDialerSlot());
    expect(s1).toMatchObject({ contactId: dois.id, phoneNumber: X });
    await runWithTeam(TEAM, () => markCallOutcome(s1!.callId, "wrong_number"));
    await paraOntem(s1!.callId);
    const s2 = await runWithTeam(TEAM, () => getNextDialerSlot());
    expect(s2).toMatchObject({ contactId: dois.id, phoneNumber: Y });

    await basePrisma.call.deleteMany({ where: { teamId: TEAM } });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
    await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
    const so = await contato("Caio", false);
    const s3 = await runWithTeam(TEAM, () => getNextDialerSlot());
    expect(s3).toMatchObject({ contactId: so.id, phoneNumber: X });
    await runWithTeam(TEAM, () => markCallOutcome(s3!.callId, "wrong_number"));
    await paraOntem(s3!.callId);
    expect(await runWithTeam(TEAM, () => getNextDialerSlot())).toBeNull();
  });
});

describe("número errado marcado por engano", () => {
  it("trocar o resultado desfaz: o número volta a valer e a tag sai; outra ligação que também deu errado mantém", async () => {
    const c = await contato("Duda", false);
    const { callId } = await runWithTeam(TEAM, () => createManualCall({ phoneNumber: X, contactId: c.id }));
    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "wrong_number" }));
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: X } })).invalido).toBe(true);

    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "answered" }));
    const idt = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: X } });
    expect(idt).toMatchObject({ invalido: false, invalidoMotivo: null });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).tags).not.toContain("Número errado");

    // Duas ligações dizem "número errado"; desfazer UMA não revalida o número.
    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "wrong_number" }));
    const outra = await runWithTeam(TEAM, () => createManualCall({ phoneNumber: X, contactId: c.id }));
    await runWithTeam(TEAM, () => finishManualCall(outra.callId, { outcome: "wrong_number" }));
    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "no_answer" }));
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: X } })).invalido).toBe(true);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).tags).toContain("Número errado");
  });
});
