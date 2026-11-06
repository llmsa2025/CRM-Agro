import { describe, it, expect, vi } from "vitest";
import { buscarPessoasCnpja, candidatosDaResposta, creditosDaPesquisa, FonteFalhou, FonteSemAcesso, FonteSemCredito } from "./cnpja";

/** Fonte PAGA: nenhum teste chama a API de verdade, o `fetch` é falso. Resposta no formato do OpenAPI. */
const resposta = {
  count: 2,
  next: "tok-2",
  records: [
    {
      id: "p1",
      type: "NATURAL",
      name: "MARIA APARECIDA SILVA",
      taxId: "***982247**",
      age: "51-60",
      membership: [{ since: "2015-01-01", role: { text: "Sócio-Administrador" }, company: { id: "11222333", name: "AGRO TESTE LTDA", equity: 100000, size: { text: "Pequeno" } } }],
    },
    { id: "p2", type: "LEGAL", name: "EMPRESA PESSOA JURIDICA", taxId: "11222333000181" },
    { id: "p3", type: "NATURAL", name: "MARIA SILVA", taxId: "12345678000190", membership: [] }, // taxId que não é máscara de CPF
    { type: "NATURAL", name: "SEM ID" },
  ],
};

describe("candidatosDaResposta", () => {
  it("só pessoa física, com a máscara do CPF, a faixa de idade e as empresas", () => {
    const p = candidatosDaResposta(resposta);
    expect(p.candidatos.map((c) => c.id)).toEqual(["p1", "p3"]);
    expect(p.candidatos[0]).toEqual({
      id: "p1",
      nome: "MARIA APARECIDA SILVA",
      cpfMascarado: "***982247**",
      faixaEtaria: "51-60",
      empresas: [{ nome: "AGRO TESTE LTDA", capital: 100000, porte: "Pequeno", qualificacao: "Sócio-Administrador" }],
    });
    expect(p.candidatos[1]!.cpfMascarado).toBeNull();
    expect(p.proximo).toBe("tok-2");
    expect(p.total).toBe(2);
  });
  it("resposta vazia", () => {
    expect(candidatosDaResposta({})).toEqual({ candidatos: [], proximo: null, total: null });
  });
});

describe("creditosDaPesquisa", () => {
  it("1 crédito a cada 10 registros, arredondando para cima, no mínimo 1", () => {
    expect([1, 10, 11, 20, 21, 100].map(creditosDaPesquisa)).toEqual([1, 1, 2, 2, 3, 10]);
    expect(creditosDaPesquisa(0)).toBe(1);
  });
});

describe("buscarPessoasCnpja (fetch falso)", () => {
  const ok = () => vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify(resposta), { status: 200 }));

  it("manda a chave só no cabeçalho, o nome em name.in e o tipo NATURAL; a chave não vai na URL", async () => {
    const f = ok();
    const p = await buscarPessoasCnpja({ chave: "CHAVE-SECRETA-123", nome: "maria silva", limite: 20 }, f as unknown as typeof fetch);
    expect(p.candidatos).toHaveLength(2);
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe("https://api.cnpja.com/person");
    expect(u.searchParams.get("name.in")).toBe("maria silva");
    expect(u.searchParams.get("type.in")).toBe("NATURAL");
    expect(u.searchParams.get("limit")).toBe("20");
    expect(String(url)).not.toContain("CHAVE-SECRETA-123");
    expect((init!.headers as Record<string, string>).Authorization).toBe("CHAVE-SECRETA-123");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("próxima página usa só o token", async () => {
    const f = ok();
    await buscarPessoasCnpja({ chave: "CHAVE-SECRETA-123", nome: "maria silva", limite: 20, token: "tok-2" }, f as unknown as typeof fetch);
    const u = new URL(String(f.mock.calls[0]![0]));
    expect([...u.searchParams.keys()]).toEqual(["token"]);
  });

  it("401 e 403 = chave recusada; 429 = sem crédito; 5xx, rede e JSON ruim = falhou. Nenhuma mensagem leva a chave", async () => {
    const com = (status: number) => vi.fn(async () => new Response("x", { status })) as unknown as typeof fetch;
    const pedido = { chave: "CHAVE-SECRETA-123", nome: "maria silva", limite: 10 };
    await expect(buscarPessoasCnpja(pedido, com(401))).rejects.toBeInstanceOf(FonteSemAcesso);
    await expect(buscarPessoasCnpja(pedido, com(403))).rejects.toBeInstanceOf(FonteSemAcesso);
    await expect(buscarPessoasCnpja(pedido, com(429))).rejects.toBeInstanceOf(FonteSemCredito);
    await expect(buscarPessoasCnpja(pedido, com(500))).rejects.toBeInstanceOf(FonteFalhou);
    await expect(buscarPessoasCnpja(pedido, vi.fn(async () => { throw new Error("CHAVE-SECRETA-123 caiu"); }) as unknown as typeof fetch)).rejects.toThrow(/erro de rede/);
    await expect(buscarPessoasCnpja(pedido, vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).rejects.toThrow(/não é JSON/);
    for (const fn of [com(401), com(429), com(500)]) {
      try {
        await buscarPessoasCnpja(pedido, fn);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain("CHAVE-SECRETA-123");
      }
    }
  });
});
