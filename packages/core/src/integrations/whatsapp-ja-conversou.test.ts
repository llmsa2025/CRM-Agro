import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWhatsAppHistory } from "@crmagro/channels";

/**
 * "Já conversou?" (hasWhatsAppHistory): o falso "não" fazia fluxo/campanha
 * mandar mensagem de primeiro contato a quem já era cliente. Sem rede: o fetch
 * é uma Evolution falsa que guarda mensagens como ela guarda (remoteJid +
 * remoteJidAlt) e filtra como o `findMessages` (OU entre os dois campos).
 */

type Guardada = { remoteJid: string; remoteJidAlt?: string };

const base = { apiUrl: "https://evolution.example", apiKey: "chave-de-teste", instance: "conta-a" };

/** Evolution falsa: total = mensagens cujo remoteJid OU remoteJidAlt bate com o filtro. */
function evolutionFalsa(guardadas: Guardada[]) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const key = JSON.parse(init.body as string).where.key as { remoteJid?: string; remoteJidAlt?: string };
    const alvos = [key.remoteJid, key.remoteJidAlt].filter((x): x is string => x !== undefined);
    const total = guardadas.filter((m) => alvos.some((a) => m.remoteJid === a || m.remoteJidAlt === a)).length;
    return Response.json({ messages: { total, pages: 1, currentPage: 1, records: [] } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Corpos JSON enviados à Evolution, um por chamada. */
const corpos = (f: ReturnType<typeof evolutionFalsa>) =>
  f.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));

afterEach(() => vi.unstubAllGlobals());

describe("já conversou? — hasWhatsAppHistory", () => {
  it("caso verdadeiro: conversa existente com o mesmo número devolve true", async () => {
    evolutionFalsa([{ remoteJid: "5566999997701@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBe(true);
  });

  it("sem conversa nenhuma devolve false (não confunde com 'não sei')", async () => {
    evolutionFalsa([{ remoteJid: "5511988887777@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBe(false);
  });

  it("@lid: mensagem gravada com o código anônimo e o telefone só em remoteJidAlt é achada", async () => {
    const fetch = evolutionFalsa([{ remoteJid: "184469901234567@lid", remoteJidAlt: "5566999997701@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBe(true);
    // A consulta manda o telefone nos DOIS campos (é isso que acha o @lid).
    for (const b of corpos(fetch)) expect(b.where.key.remoteJidAlt).toBe(b.where.key.remoteJid);
  });

  it("número cadastrado COM o 9º dígito, conversa gravada SEM ele: acha", async () => {
    evolutionFalsa([{ remoteJid: "556699997701@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBe(true);
  });

  it("número cadastrado SEM o 9º dígito, conversa gravada COM ele: acha", async () => {
    evolutionFalsa([{ remoteJid: "5566999997701@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "+556699997701" })).toBe(true);
  });

  it("@lid + telefone alternativo sem o 9: também acha", async () => {
    evolutionFalsa([{ remoteJid: "184469901234567@lid", remoteJidAlt: "556699997701@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBe(true);
  });

  it("consulta uma vez por variante (com e sem 9), com offset 1 e a instância codificada na URL", async () => {
    const fetch = evolutionFalsa([]);
    await hasWhatsAppHistory({ ...base, instance: "conta a/1", number: "+5566999997701" });
    const jids = corpos(fetch).map((b) => b.where.key.remoteJid).sort();
    expect(jids).toEqual(["556699997701@s.whatsapp.net", "5566999997701@s.whatsapp.net"]);
    expect(corpos(fetch).every((b) => b.offset === 1)).toBe(true);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://evolution.example/chat/findMessages/conta%20a%2F1");
  });

  it("número sem variante (fora do Brasil) faz uma consulta só", async () => {
    const fetch = evolutionFalsa([]);
    await hasWhatsAppHistory({ ...base, number: "+14155550123" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aceita o número sem o '+' inicial", async () => {
    evolutionFalsa([{ remoteJid: "5566999997701@s.whatsapp.net" }]);
    expect(await hasWhatsAppHistory({ ...base, number: "5566999997701" })).toBe(true);
  });

  it("achou numa variante e a outra deu erro: true (já conversou é certeza)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const jid = JSON.parse(init.body as string).where.key.remoteJid as string;
        if (jid === "556699997701@s.whatsapp.net") return new Response("erro", { status: 500 });
        return Response.json({ messages: { total: 3 } });
      }),
    );
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBe(true);
  });

  it("uma variante deu 0 e a outra falhou: null (não sei), nunca false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const jid = JSON.parse(init.body as string).where.key.remoteJid as string;
        if (jid === "556699997701@s.whatsapp.net") throw new Error("Evolution fora do ar");
        return Response.json({ messages: { total: 0 } });
      }),
    );
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBeNull();
  });

  it("formato inesperado ou erro HTTP em todas as consultas: null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ foo: 1 })));
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 503 })));
    expect(await hasWhatsAppHistory({ ...base, number: "+5566999997701" })).toBeNull();
  });
});
