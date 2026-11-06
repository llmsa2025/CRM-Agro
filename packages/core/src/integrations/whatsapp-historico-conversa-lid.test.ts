import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWhatsAppChatMessages } from "@crmagro/channels";

/**
 * Conversa de UM número na Evolution (`fetchWhatsAppChatMessages`): a mensagem ao vivo traz o @lid em `remoteJid` e o
 * telefone em `remoteJidAlt`; as ANTIGAS do mesmo chat (pacote de histórico) só existem sob o @lid. A busca pelo
 * telefone sozinha devolvia a conversa pela metade, então ela segue o @lid que a própria Evolution amarrou ao número.
 * Evolution falsa: nada vai à rede.
 */
afterEach(() => vi.unstubAllGlobals());

const base = { apiUrl: "https://evolution.example", apiKey: "chave-falsa", instance: "inst-a", number: "+5566999998888" };
const LID = "184469901234567@lid";
const OUTRO_LID = "999888777666555@lid";
const COM_9 = "5566999998888@s.whatsapp.net";
const SEM_9 = "556699998888@s.whatsapp.net";

type Reg = Record<string, unknown>;
const aoVivo = (id: string, ts: number): Reg => ({ key: { remoteJid: LID, remoteJidAlt: COM_9, fromMe: false, id }, message: { conversation: `vivo ${id}` }, messageTimestamp: ts, pushName: "Fulano" });
const antiga = (id: string, ts: number, fromMe = false): Reg => ({ key: { remoteJid: LID, fromMe, id }, message: { conversation: `antiga ${id}` }, messageTimestamp: ts });

/** Evolution falsa: devolve os registros do JID que veio em `where.key.remoteJid` e anota quais JIDs foram consultados. */
function evolutionFalsa(porJid: Record<string, Reg[]>) {
  const jids: string[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const jid = (JSON.parse(init.body as string) as { where: { key: { remoteJid: string } } }).where.key.remoteJid;
    jids.push(jid);
    const records = porJid[jid] ?? [];
    return Response.json({ messages: { total: records.length, pages: 1, currentPage: 1, records } });
  });
  vi.stubGlobal("fetch", fetch);
  return jids;
}

describe("fetchWhatsAppChatMessages: segue o @lid do número", () => {
  it("achou mensagem ao vivo com o @lid: consulta o @lid e traz também as antigas, em ordem", async () => {
    const jids = evolutionFalsa({ [COM_9]: [aoVivo("V1", 1_700_000_900)], [LID]: [aoVivo("V1", 1_700_000_900), antiga("A2", 1_600_000_100, true), antiga("A1", 1_600_000_000)] });
    const msgs = await fetchWhatsAppChatMessages(base);
    expect(msgs.map((m) => m.providerMessageId)).toEqual(["A1", "A2", "V1"]);
    expect(msgs.map((m) => m.fromMe)).toEqual([false, true, false]);
    expect(jids).toEqual([COM_9, SEM_9, LID]); // as duas variantes do número, depois o @lid achado
  });

  it("o registro que amarra o par pode nem ser mensagem (reação): o @lid é seguido do mesmo jeito", async () => {
    const reacao: Reg = { key: { remoteJid: LID, remoteJidAlt: COM_9, fromMe: false, id: "R1" }, message: { reactionMessage: { text: "👍" } }, messageTimestamp: 1_700_000_950 };
    const jids = evolutionFalsa({ [COM_9]: [reacao], [LID]: [reacao, antiga("A1", 1_600_000_000)] });
    const msgs = await fetchWhatsAppChatMessages(base);
    expect(msgs.map((m) => m.providerMessageId)).toEqual(["A1"]);
    expect(jids).toEqual([COM_9, SEM_9, LID]);
  });

  it("só o telefone no banco (sem @lid): não consulta mais nada", async () => {
    const jids = evolutionFalsa({ [COM_9]: [{ key: { remoteJid: COM_9, fromMe: true, id: "T1" }, message: { conversation: "oi" }, messageTimestamp: 1_700_000_000 }] });
    const msgs = await fetchWhatsAppChatMessages(base);
    expect(msgs.map((m) => m.providerMessageId)).toEqual(["T1"]);
    expect(jids).toEqual([COM_9, SEM_9]);
  });

  it("@lid que já veio em jidsExtras (mapa do time) não é consultado duas vezes", async () => {
    const jids = evolutionFalsa({ [COM_9]: [aoVivo("V1", 1_700_000_900)], [LID]: [aoVivo("V1", 1_700_000_900), antiga("A1", 1_600_000_000)] });
    const msgs = await fetchWhatsAppChatMessages({ ...base, jidsExtras: [LID] });
    expect(msgs.map((m) => m.providerMessageId)).toEqual(["A1", "V1"]);
    expect(jids.filter((j) => j === LID)).toHaveLength(1);
  });

  it("nunca segue o @lid de OUTRA pessoa: o telefone da mensagem tem de ser uma variante do número", async () => {
    const deOutro: Reg = { key: { remoteJid: OUTRO_LID, remoteJidAlt: "5565911112222@s.whatsapp.net", id: "X1" }, message: { conversation: "não é dele" }, messageTimestamp: 1_700_000_000 };
    const jids = evolutionFalsa({ [COM_9]: [deOutro], [OUTRO_LID]: [antiga("X2", 1_600_000_000)] });
    await fetchWhatsAppChatMessages(base);
    expect(jids).not.toContain(OUTRO_LID);
  });

  it("mensagem só com @lid (sem telefone) não abre uma busca nova: o par não existe, nada é inventado", async () => {
    const jids = evolutionFalsa({ [LID]: [antiga("A1", 1_600_000_000)] });
    const msgs = await fetchWhatsAppChatMessages({ ...base, jidsExtras: [LID] });
    expect(msgs.map((m) => m.providerMessageId)).toEqual(["A1"]);
    expect(jids).toEqual([COM_9, SEM_9, LID]);
  });

  it("número sem nada na Evolution devolve lista vazia", async () => {
    evolutionFalsa({});
    expect(await fetchWhatsAppChatMessages(base)).toEqual([]);
  });
});
