import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWhatsAppHistoryPage } from "@crmagro/channels";

afterEach(() => vi.unstubAllGlobals());
const input = { apiUrl: "https://evolution.example", apiKey: "test", instance: "a/b", page: 2, until: "2026-09-27T12:00:00.000Z" };
describe("páginas de histórico da Evolution", () => {
  it("usa offset/page e datas ISO; preserva LID sem inventar telefone e ignora grupos/registros sem ID ou data", async () => {
    const record = { key: { id: "a", remoteJid: "5565999991111@s.whatsapp.net" }, pushName: null, messageTimestamp: 1700000000, message: { conversation: "oi" } };
    const fetch = vi.fn(async () => Response.json({ messages: { total: 7, pages: 2, currentPage: 2, records: [
      record,
      { ...record, pushName: "Dono da Conta", key: { ...record.key, id: "out", fromMe: true } },
      { ...record, key: { ...record.key, remoteJid: "123@g.us" } },
      { ...record, key: { ...record.key, id: "unresolved", remoteJid: "123@lid" } },
      { ...record, key: { ...record.key, id: undefined } },
      { ...record, messageTimestamp: undefined },
      { ...record, key: { ...record.key, id: "lid", remoteJid: "123@lid", remoteJidAlt: "5565999992222@s.whatsapp.net" } },
    ] } }));
    vi.stubGlobal("fetch", fetch);
    const p = await fetchWhatsAppHistoryPage(input);
    expect(p.records).toBe(7);
    expect(p.messages).toHaveLength(4);
    expect(p.messages[1]?.fromMe).toBe(true);
    // Enviada: o pushName é o do próprio dono — nunca chega como nome.
    expect(p.messages[1]?.name).toBeNull();
    expect(p.messages[2]?.from).toBe("123@lid");
    expect(p.messages[3]?.from).toBe("+5565999992222");
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://evolution.example/chat/findMessages/a%2Fb");
    expect(JSON.parse(call[1].body as string)).toEqual({ page: 2, offset: 250, where: { messageTimestamp: { gte: "2009-01-01T00:00:00.000Z", lte: input.until } } });
  });
  it("tamanho 1 só confere o total (offset = tamanho da página na Evolution)", async () => {
    const um = { key: { id: "x", remoteJid: "5565999991111@s.whatsapp.net" }, messageTimestamp: 1700000000, message: { conversation: "oi" } };
    const fetch = vi.fn(async () => Response.json({ messages: { total: 9, pages: 9, currentPage: 1, records: [um] } }));
    vi.stubGlobal("fetch", fetch);
    expect((await fetchWhatsAppHistoryPage({ ...input, page: 1, tamanho: 1 })).total).toBe(9);
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toMatchObject({ page: 1, offset: 1 });
  });
  it("erro HTTP ou payload inválido falha para permitir retry, nunca vira histórico vazio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("erro", { status: 500 })));
    await expect(fetchWhatsAppHistoryPage(input)).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages: { total: 10 } })));
    await expect(fetchWhatsAppHistoryPage(input)).rejects.toThrow();
  });
});
