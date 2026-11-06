import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { env } from "@crmagro/config";
import type { InboundMessage } from "@crmagro/channels";

/**
 * O mapa @lid → telefone fora do ar (ex.: migration ainda não aplicada) NÃO pode
 * travar a importação do histórico: ela segue como antes (conversa "sem número").
 * O módulo do mapa é trocado por um que sempre falha, só neste arquivo.
 */
vi.mock("../conversations/lid-mapa", () => ({
  gravarParesLid: vi.fn(async () => { throw new Error('relation "WhatsAppLid" does not exist'); }),
  lerParesLid: vi.fn(async () => { throw new Error('relation "WhatsAppLid" does not exist'); }),
  lidResumido: (l: string) => l,
}));
const { importarPaginaHistorico } = await import("./whatsapp-historico");

const TEAM = "00000000-0000-0000-0000-0000000a11e3";
const INSTANCE = "historico-lid-falha";
const LID = "184469901234567@lid";
let accountId = "";
const ts = 1_790_000_000;
const msg = (id: string, extra: Partial<InboundMessage>): InboundMessage => ({
  providerMessageId: id, instance: INSTANCE, from: LID, remoteJid: LID, fromMe: false,
  text: "mensagem", timestamp: ts, name: null, media: null, ...extra,
});

async function limpar() {
  const w = { teamId: TEAM };
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}
beforeAll(async () => {
  env.WA_HISTORICO_MODO = "completo";
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Teste histórico @lid (falha)" } });
});
beforeEach(async () => {
  await limpar();
  accountId = (await basePrisma.channelAccount.create({
    data: { teamId: TEAM, label: "WA", provider: "evolution", canal: "whatsapp", externalId: INSTANCE, status: "connected" },
  })).id;
});
afterAll(async () => {
  await limpar();
  await basePrisma.team.deleteMany({ where: { id: TEAM } });
});

describe("importação do histórico com o mapa @lid indisponível", () => {
  it("importa do mesmo jeito: a mensagem do pacote vira conversa 'sem número' e a ao vivo, a do telefone", async () => {
    const n = await importarPaginaHistorico({ accountId, teamId: TEAM, instance: INSTANCE }, [
      msg("live", { from: "+5566999998888", text: "ao vivo" }),
      msg("pack", { timestamp: ts - 100 }),
    ]);
    expect(n).toBe(2);
    const convs = await basePrisma.conversation.findMany({ where: { teamId: TEAM }, orderBy: { externalNumber: "asc" } });
    expect(convs.map((c) => c.externalNumber).sort()).toEqual(["+5566999998888", LID].sort());
    expect(await basePrisma.message.count({ where: { teamId: TEAM } })).toBe(2);
  });
});
