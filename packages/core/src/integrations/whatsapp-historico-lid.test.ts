import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { basePrisma } from "@crmagro/db";
import { env } from "@crmagro/config";
import type { InboundMessage } from "@crmagro/channels";

/**
 * Importador do histórico × conversa "sem número" (@lid): quando o CRM Agro já sabe
 * de quem é o código anônimo, a mensagem antiga entra na conversa do NÚMERO em
 * vez de criar a conversa "sem número" da mesma pessoa.
 * Banco de TESTE; nada vai à rede.
 */
const { importarPaginaHistorico } = await import("./whatsapp-historico");
const { gravarParesLid, lerParesLid } = await import("../conversations/lid-mapa");

const TEAM = "00000000-0000-0000-0000-0000000a11e1";
const OUTRO = "00000000-0000-0000-0000-0000000a11e2";
const INSTANCE = "historico-lid-test";
const LID = "184469901234567@lid";
const TEL = "+5566999998888";
let accountId = "";
let contactId = "";
const job = () => ({ accountId, teamId: TEAM, instance: INSTANCE });
const ts = 1_790_000_000;

/** Mensagem AO VIVO: o `from` já é o telefone e o `remoteJid` original é o @lid. */
const aoVivo = (id: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  providerMessageId: id, instance: INSTANCE, from: TEL, remoteJid: LID, fromMe: false,
  text: "mensagem ao vivo", timestamp: ts, name: "Maria", media: null, ...extra,
});
/** Mensagem do PACOTE de histórico: só o @lid, sem telefone. */
const doPacote = (id: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  providerMessageId: id, instance: INSTANCE, from: LID, remoteJid: LID, fromMe: false,
  text: "mensagem do pacote", timestamp: ts - 1000, name: null, media: null, ...extra,
});

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.whatsAppLid.deleteMany({ where: w });
    await basePrisma.message.deleteMany({ where: w });
    await basePrisma.conversation.deleteMany({ where: w });
    await basePrisma.channelIdentifier.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
    await basePrisma.channelAccount.deleteMany({ where: w });
  }
}

beforeAll(async () => {
  env.WA_HISTORICO_MODO = "completo";
  for (const id of [TEAM, OUTRO]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: "Teste histórico @lid" } });
});
beforeEach(async () => {
  await limpar();
  accountId = (await basePrisma.channelAccount.create({
    data: { teamId: TEAM, label: "WA", provider: "evolution", canal: "whatsapp", externalId: INSTANCE, status: "connected" },
  })).id;
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria do Posto" } });
  contactId = c.id;
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId, canal: "whatsapp", valor: TEL, isPrimary: true } });
});
afterAll(async () => {
  await limpar();
  await basePrisma.team.deleteMany({ where: { id: { in: [TEAM, OUTRO] } } });
});

const conversas = () => basePrisma.conversation.findMany({ where: { teamId: TEAM }, orderBy: { createdAt: "asc" } });

describe("importação do histórico com @lid", () => {
  it("o par vem na própria página: as mensagens só-@lid entram na conversa do número e nenhuma conversa 'sem número' nasce", async () => {
    const n = await importarPaginaHistorico(job(), [aoVivo("live-1"), doPacote("pack-1"), doPacote("pack-2", { timestamp: ts - 2000 })]);
    expect(n).toBe(3);
    const cs = await conversas();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ contactId, externalNumber: null });
    expect(await basePrisma.message.count({ where: { conversationId: cs[0]!.id } })).toBe(3);
    // O par ficou guardado, com a origem certa.
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "historico" });
  });

  it("o par já era conhecido (webhook, Evolution, tela): a página só com mensagens do pacote cai na conversa do número", async () => {
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "evolution");
    await importarPaginaHistorico(job(), [doPacote("pack-1"), doPacote("pack-2", { timestamp: ts - 2000 })]);
    const cs = await conversas();
    expect(cs).toHaveLength(1);
    expect(cs[0]?.contactId).toBe(contactId);
  });

  it("sem par em lugar nenhum: continua a conversa 'sem número' de antes (nada é inventado)", async () => {
    await importarPaginaHistorico(job(), [doPacote("pack-1")]);
    const cs = await conversas();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ contactId: null, externalNumber: LID });
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("o par de OUTRO time não vale para este (o @lid é o mesmo, o time não)", async () => {
    await gravarParesLid(basePrisma, OUTRO, [{ lid: LID, telefone: TEL }], "evolution");
    await importarPaginaHistorico(job(), [doPacote("pack-1")]);
    expect((await conversas())[0]).toMatchObject({ contactId: null, externalNumber: LID });
  });

  it("repetir a importação da página não duplica mensagem nem conversa", async () => {
    const pagina = [aoVivo("live-1"), doPacote("pack-1")];
    expect(await importarPaginaHistorico(job(), pagina)).toBe(2);
    expect(await importarPaginaHistorico(job(), pagina)).toBe(0);
    expect(await conversas()).toHaveLength(1);
    expect(await basePrisma.message.count({ where: { teamId: TEAM } })).toBe(2);
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("não junta conversa que JÁ existe: só decide onde a mensagem nova entra (a junção é a unificação, revisada pela pessoa)", async () => {
    // Conversa "sem número" criada ANTES de o par ser conhecido.
    await importarPaginaHistorico(job(), [doPacote("pack-velho")]);
    // Agora chega uma página com o par (e outra mensagem do pacote).
    await importarPaginaHistorico(job(), [aoVivo("live-1"), doPacote("pack-novo", { timestamp: ts - 5000 })]);
    const cs = await conversas();
    expect(cs).toHaveLength(2); // a antiga segue separada até a unificação
    expect(cs.find((c) => c.externalNumber === LID)).toBeTruthy();
    expect(await basePrisma.message.count({ where: { conversationId: cs.find((c) => c.contactId === contactId)!.id } })).toBe(2);
  });
});
