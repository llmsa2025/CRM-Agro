import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { redisEstado } from "../shared/redis-cache";

/**
 * Se a unificação FALHAR depois de a Evolution responder, a marca "já procurei
 * este telefone" (30 dias) NÃO pode ser gravada: senão o par nunca mais seria
 * aplicado sozinho. O mapa é trocado por um que falha ao gravar, só neste arquivo.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));
vi.mock("./lid-mapa", async (original) => ({
  ...(await original<typeof import("./lid-mapa")>()),
  gravarParesLid: vi.fn(async () => {
    throw new Error("banco indisponível ao gravar o par");
  }),
}));
const { receiveInbound } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000a11d3";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `lid-falha-${sufixo}`;
const LID = "184469901234567@lid";
const TEL = "+5566999998888";
let contaId = "";

async function limpar() {
  const w = { teamId: TEAM };
  await basePrisma.whatsAppLid.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}
beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team LID falha (test)" } });
});
beforeEach(async () => {
  await limpar();
  contaId = (await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" } })).id;
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria" } });
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: TEL, isPrimary: true } });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await limpar();
  await basePrisma.team.deleteMany({ where: { id: TEAM } });
});

describe("descoberta do @lid quando a unificação falha", () => {
  it("a mensagem é gravada, a conversa segue separada, NÃO grava 'já procurei' e a conta descansa", async () => {
    const lid = await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: LID } });
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ messages: { total: 1, pages: 1, currentPage: 1, records: [{ key: { remoteJid: LID, remoteJidAlt: "5566999998888@s.whatsapp.net", id: "X" } }] } }),
    ));
    await receiveInbound({
      from: TEL, fromMe: false, text: "oi", media: null, providerMessageId: `${sufixo}-in-1`, timestamp: null, name: "Maria",
      instance: INSTANCIA, remoteJid: "5566999998888@s.whatsapp.net",
    });
    expect(await basePrisma.message.count({ where: { teamId: TEAM, providerMessageId: `${sufixo}-in-1` } })).toBe(1);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
    expect(await redisEstado().exists(`wa:lid:procurado:${contaId}:${TEL}`)).toBe(0); // sem a marca de 30 dias
    expect(await redisEstado().exists(`wa:lid:falha:${contaId}`)).toBe(1); // só o descanso curto
    await redisEstado().del(`wa:lid:falha:${contaId}`);
  });
});
