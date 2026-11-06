import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Bug: quem respondia na aba do Instagram (ou do LinkedIn) mandava um WHATSAPP para o celular do contato.
 * `sendMessage` pegava o telefone do contato e, sem provedor para o canal, caía no primeiro WhatsApp conectado.
 * Agora conversa de outro canal recusa o envio. O CANAL É MOCKADO: nada vai à rede.
 */
vi.mock("../flows/queue", () => ({ scheduleStep: vi.fn(), getFlowQueue: () => ({}) }));
const canal = vi.hoisted(() => ({
  send: vi.fn(async (_: unknown) => ({ providerMessageId: `WAMID-${Math.random()}` })),
  sendMedia: vi.fn(async (_: unknown) => ({ providerMessageId: `WAMID-${Math.random()}` })),
  sendPresence: vi.fn(async (_: unknown) => {}),
}));
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => canal,
  defaultEvolutionProvider: () => canal,
}));

const { sendMessage, sendMediaMessage, sendTyping } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000009e2";
const sufixo = Math.random().toString(36).slice(2, 8);
const NUMERO = "5565988884444";
const conversas: Record<string, string> = {};

const FOTO = Buffer.from("foto").toString("base64");

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Canal sem envio (test)" } });
});

beforeEach(async () => {
  canal.send.mockClear();
  canal.sendMedia.mockClear();
  canal.sendPresence.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true } });
  // Um WhatsApp CONECTADO (a rota de fuga do bug) e uma conta de cada outro canal.
  for (const c of ["whatsapp", "instagram", "linkedin", "email"] as const) {
    const conta = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: c, label: c, provider: c === "whatsapp" ? "evolution" : c, externalId: `${c}-${sufixo}`, credentials: { instance: `i-${sufixo}` }, status: "connected" },
    });
    const conv = await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: contato.id, canal: c, channelAccountId: conta.id } as never });
    conversas[c] = conv.id;
  }
});

const mensagens = () => basePrisma.message.count({ where: { teamId: TEAM } });

describe("conversa de outro canal não envia pelo WhatsApp", () => {
  for (const c of ["instagram", "linkedin", "email"] as const) {
    it(`${c}: texto recusado, nada sai e nada é gravado`, async () => {
      await expect(runWithTeam(TEAM, () => sendMessage(conversas[c]!, "oi"))).rejects.toMatchObject({ name: "CanalSemEnvioDireto" });
      expect(canal.send).not.toHaveBeenCalled();
      expect(await mensagens()).toBe(0);
    });

    it(`${c}: mídia recusada, nada sai e nada é gravado`, async () => {
      await expect(
        runWithTeam(TEAM, () => sendMediaMessage(conversas[c]!, { mediaPath: "x/y.png", mediaMime: "image/png", base64: FOTO })),
      ).rejects.toMatchObject({ name: "CanalSemEnvioDireto" });
      expect(canal.sendMedia).not.toHaveBeenCalled();
      expect(await mensagens()).toBe(0);
    });

    it(`${c}: "digitando" não vai para o WhatsApp do contato`, async () => {
      await runWithTeam(TEAM, () => sendTyping(conversas[c]!, 1000));
      expect(canal.sendPresence).not.toHaveBeenCalled();
    });
  }

  it("a mensagem de erro diz o canal e o que fazer, sem travessão", async () => {
    const e = await runWithTeam(TEAM, () => sendMessage(conversas.instagram!, "oi")).catch((x: Error) => x);
    expect((e as Error).message).toBe("O envio por Instagram ainda não sai pelo CRM Agro. Responda pelo aplicativo do Instagram por enquanto.");
    expect((e as Error).message).not.toMatch(/[—–]/);
  });

  it("conversa de WhatsApp continua enviando", async () => {
    await runWithTeam(TEAM, () => sendMessage(conversas.whatsapp!, "oi"));
    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(await mensagens()).toBe(1);
    await runWithTeam(TEAM, () => sendTyping(conversas.whatsapp!, 1000));
    expect(canal.sendPresence).toHaveBeenCalledTimes(1);
  });
});
