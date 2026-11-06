import { afterEach, describe, expect, it, vi } from "vitest";
import { buscarParesLidNaEvolution, descobrirLidDoTelefone, descobrirTelefoneDoLid, parLidDaChave } from "@crmagro/channels";

/**
 * Leitura do par @lid ↔ telefone no banco da Evolution (`findMessages`), SÓ
 * leitura. Evolution falsa: nada vai à rede. O formato dos registros é o que a
 * 2.3.7 grava (`key.remoteJid` = @lid, `key.remoteJidAlt` = telefone).
 */
afterEach(() => vi.unstubAllGlobals());

const base = { apiUrl: "https://evolution.example", apiKey: "chave-falsa", instance: "a/b" };
const LID = "184469901234567@lid";
const JID_TEL = "5566999998888@s.whatsapp.net";

type Reg = { key: Record<string, unknown> };
const pagina = (records: Reg[], pages = 1, currentPage = 1) =>
  Response.json({ messages: { total: records.length, pages, currentPage, records } });

describe("parLidDaChave", () => {
  it("@lid + telefone em remoteJidAlt (ou no nome antigo, senderPn) forma o par", () => {
    expect(parLidDaChave({ remoteJid: LID, remoteJidAlt: JID_TEL })).toEqual({ lid: LID, telefone: "+5566999998888" });
    expect(parLidDaChave({ remoteJid: LID, senderPn: JID_TEL })).toEqual({ lid: LID, telefone: "+5566999998888" });
  });

  it("sem telefone de verdade não há par (nada é inventado)", () => {
    expect(parLidDaChave({ remoteJid: LID })).toBeNull();
    expect(parLidDaChave({ remoteJid: LID, remoteJidAlt: "999@lid" })).toBeNull(); // outro @lid não é telefone
    expect(parLidDaChave({ remoteJid: JID_TEL, remoteJidAlt: JID_TEL })).toBeNull(); // já é telefone
    expect(parLidDaChave({ remoteJid: "120363@g.us", remoteJidAlt: JID_TEL })).toBeNull(); // grupo
    expect(parLidDaChave({ remoteJid: LID, remoteJidAlt: "123@s.whatsapp.net" })).toBeNull(); // telefone inválido
  });
});

describe("buscarParesLidNaEvolution", () => {
  it("manda o MESMO jid em remoteJid e remoteJidAlt (o OU da consulta) e devolve o par da pessoa", async () => {
    const fetch = vi.fn(async () => pagina([{ key: { remoteJid: LID, remoteJidAlt: JID_TEL, id: "A" } }, { key: { remoteJid: LID, id: "pacote" } }]));
    vi.stubGlobal("fetch", fetch);
    const pares = await buscarParesLidNaEvolution({ ...base, jid: JID_TEL });
    expect(pares).toEqual([{ lid: LID, telefone: "+5566999998888" }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://evolution.example/chat/findMessages/a%2Fb");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ where: { key: { remoteJid: JID_TEL, remoteJidAlt: JID_TEL } }, offset: 50, page: 1 });
  });

  it("registro de OUTRA pessoa nunca entra: o par tem de casar com o jid pedido", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pagina([{ key: { remoteJid: "999888777666555@lid", remoteJidAlt: "5565911112222@s.whatsapp.net" } }])));
    expect(await buscarParesLidNaEvolution({ ...base, jid: JID_TEL })).toEqual([]);
    expect(await buscarParesLidNaEvolution({ ...base, jid: LID })).toEqual([]);
  });

  it("pelo @lid acha o telefone, e o telefone antigo sem o 9º dígito também casa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pagina([{ key: { remoteJid: LID, remoteJidAlt: "556699998888@s.whatsapp.net" } }])));
    expect(await descobrirTelefoneDoLid({ ...base, lid: LID })).toBe("+556699998888");
    expect(await buscarParesLidNaEvolution({ ...base, jid: JID_TEL })).toHaveLength(1); // variante com/sem 9
  });

  it("sem par na 1ª página, lê a 2ª (no máximo 2) e para ao achar", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(pagina([{ key: { remoteJid: LID, id: "pacote" } }], 3, 1))
      .mockResolvedValueOnce(pagina([{ key: { remoteJid: LID, remoteJidAlt: JID_TEL } }], 3, 2));
    vi.stubGlobal("fetch", fetch);
    expect(await buscarParesLidNaEvolution({ ...base, jid: LID })).toEqual([{ lid: LID, telefone: "+5566999998888" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockImplementation(async () => pagina([{ key: { remoteJid: LID } }], 9, 1));
    expect(await buscarParesLidNaEvolution({ ...base, jid: LID })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2); // teto de 2 páginas
  });

  it("erro HTTP ou formato inesperado LANÇA (é 'não deu para saber', nunca 'não tem par')", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("erro", { status: 500 })));
    await expect(buscarParesLidNaEvolution({ ...base, jid: LID })).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages: { total: 1 } })));
    await expect(buscarParesLidNaEvolution({ ...base, jid: LID })).rejects.toThrow();
  });

  it("descobrirTelefoneDoLid ignora o que não é @lid sem nem chamar a Evolution", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await descobrirTelefoneDoLid({ ...base, lid: "5566999998888@s.whatsapp.net" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("descobrirLidDoTelefone", () => {
  it("pergunta por cada variante do número (com e sem o 9) e devolve o @lid achado", async () => {
    const fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
      const jid = JSON.parse(init.body as string).where.key.remoteJid as string;
      return jid === "556699998888@s.whatsapp.net" ? pagina([{ key: { remoteJid: LID, remoteJidAlt: jid } }]) : pagina([]);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await descobrirLidDoTelefone({ ...base, telefone: "+5566999998888" })).toBe(LID);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uma variante falhou e outra achou: vale o que achou; todas falharam: lança; nenhuma tem par: null", async () => {
    const meio = vi.fn(async (_u: unknown, init: RequestInit) => {
      const jid = JSON.parse(init.body as string).where.key.remoteJid as string;
      if (jid === JID_TEL) throw new TypeError("fetch failed");
      return pagina([{ key: { remoteJid: LID, remoteJidAlt: jid } }]);
    });
    vi.stubGlobal("fetch", meio);
    expect(await descobrirLidDoTelefone({ ...base, telefone: "+5566999998888" })).toBe(LID);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(descobrirLidDoTelefone({ ...base, telefone: "+5566999998888" })).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => pagina([])));
    expect(await descobrirLidDoTelefone({ ...base, telefone: "+5566999998888" })).toBeNull();
  });
});
