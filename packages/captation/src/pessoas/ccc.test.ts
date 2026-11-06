import { describe, it, expect, vi } from "vitest";
import { consultarIeProdutorCnpja, ProdutorSemInscricao, resultadoDoCcc } from "./ccc";
import { FonteFalhou, FonteSemAcesso, FonteSemCredito } from "./cnpja";

/** Fonte PAGA: o `fetch` é falso, nenhum teste chama a API. CPF de teste inventado e válido. */
const CPF = "529.982.247-25";
const corpo = {
  taxId: "52998224725",
  updated: "2026-10-01T10:00:00.000Z",
  name: "MARIA APARECIDA SILVA",
  originState: "MT",
  registrations: [
    { number: "13.456.789-0", state: "MT", enabled: true, statusDate: "2020-05-10", status: { id: 1, text: "Habilitada" }, type: { id: 2, text: "Produtor rural" } },
    { number: "", state: "MT", enabled: true }, // sem número: ignorada
  ],
};

describe("resultadoDoCcc", () => {
  it("mapeia as inscrições (número, UF, habilitada, situação, tipo, data) e ignora a sem número", () => {
    expect(resultadoDoCcc(corpo)).toEqual({
      nome: "MARIA APARECIDA SILVA",
      ufDeOrigem: "MT",
      atualizadoEm: "2026-10-01T10:00:00.000Z",
      ies: [{ numero: "13.456.789-0", uf: "MT", habilitada: true, situacao: "Habilitada", tipo: "Produtor rural", situacaoEm: "2020-05-10" }],
    });
    expect(resultadoDoCcc({})).toEqual({ nome: null, ufDeOrigem: null, atualizadoEm: null, ies: [] });
  });
});

describe("consultarIeProdutorCnpja (fetch falso)", () => {
  const ok = () => vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify(corpo), { status: 200 }));

  it("manda o CPF (só dígitos) e a UF como o fornecedor exige; a chave vai no cabeçalho, não na URL", async () => {
    const f = ok();
    const r = await consultarIeProdutorCnpja({ chave: "CHAVE-SECRETA-123", cpf: CPF, uf: "MT" }, f as unknown as typeof fetch);
    expect(r.ies).toHaveLength(1);
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe("https://api.cnpja.com/ccc");
    expect(u.searchParams.get("taxId")).toBe("52998224725");
    expect(u.searchParams.get("states")).toBe("MT");
    expect(u.searchParams.get("strategy")).toBe("CACHE_IF_FRESH"); // consulta em cache não gasta crédito
    expect(String(url)).not.toContain("CHAVE-SECRETA-123");
    expect((init!.headers as Record<string, string>).Authorization).toBe("CHAVE-SECRETA-123");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("CPF ou UF inválidos não chegam à rede", async () => {
    const f = ok();
    await expect(consultarIeProdutorCnpja({ chave: "k-123456789", cpf: "123", uf: "MT" }, f as unknown as typeof fetch)).rejects.toBeInstanceOf(FonteFalhou);
    await expect(consultarIeProdutorCnpja({ chave: "k-123456789", cpf: CPF, uf: "mt" }, f as unknown as typeof fetch)).rejects.toBeInstanceOf(FonteFalhou);
    expect(f).not.toHaveBeenCalled();
  });

  it("404 = sem inscrição nessa UF; 401/403 = chave; 429 = sem crédito; 5xx e rede = falhou; nenhuma mensagem leva a chave nem o CPF", async () => {
    const com = (status: number) => vi.fn(async () => new Response("x", { status })) as unknown as typeof fetch;
    const p = { chave: "CHAVE-SECRETA-123", cpf: CPF, uf: "GO" };
    await expect(consultarIeProdutorCnpja(p, com(404))).rejects.toBeInstanceOf(ProdutorSemInscricao);
    await expect(consultarIeProdutorCnpja(p, com(401))).rejects.toBeInstanceOf(FonteSemAcesso);
    await expect(consultarIeProdutorCnpja(p, com(429))).rejects.toBeInstanceOf(FonteSemCredito);
    await expect(consultarIeProdutorCnpja(p, com(503))).rejects.toBeInstanceOf(FonteFalhou);
    const rede = vi.fn(async () => { throw new Error("CHAVE-SECRETA-123 52998224725"); }) as unknown as typeof fetch;
    for (const fn of [com(404), com(401), com(429), com(503), rede]) {
      try {
        await consultarIeProdutorCnpja(p, fn);
      } catch (e) {
        expect(String((e as Error).message)).not.toMatch(/CHAVE-SECRETA|52998224725/);
      }
    }
  });
});
