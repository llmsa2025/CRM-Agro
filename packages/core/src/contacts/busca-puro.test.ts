import { describe, expect, it } from "vitest";
import { interpretarBusca, normalizarBusca, soDigitos, variantesDeTelefone } from "./busca";

/** Peças puras da busca de Contatos (sem banco): normalização, palavras, telefone e CNPJ. */
describe("normalizarBusca", () => {
  it("tira acento e diferença de maiúscula, mantendo o tamanho do texto", () => {
    expect(normalizarBusca("JOSÉ da Conceição")).toBe("jose da conceicao");
    expect(normalizarBusca("São Luís do Maranhão")).toBe("sao luis do maranhao");
    expect(normalizarBusca("ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ")).toBe("aaaaaaeeeeiiiiooooouuuucn");
    const t = "Ação Ñandú Ünico";
    expect(normalizarBusca(t)).toHaveLength(t.length);
  });
});

describe("interpretarBusca", () => {
  it("menos de 2 caracteres não é busca", () => {
    expect(interpretarBusca(undefined)).toEqual([]);
    expect(interpretarBusca("")).toEqual([]);
    expect(interpretarBusca("   ")).toEqual([]);
    expect(interpretarBusca("a")).toEqual([]);
    expect(interpretarBusca(" j ")).toEqual([]);
  });

  it("separa em palavras normalizadas (todas precisam aparecer)", () => {
    const p = interpretarBusca("  José   SILVA  ");
    expect(p.map((x) => x.texto)).toEqual(["jose", "silva"]);
    expect(p.map((x) => x.original)).toEqual(["José", "SILVA"]);
  });

  it("palavra de 1 letra no meio de outras é ignorada", () => {
    expect(interpretarBusca("maria d silva").map((x) => x.texto)).toEqual(["maria", "silva"]);
  });

  it("limita a quantidade de palavras e o tamanho do texto", () => {
    expect(interpretarBusca("a1 b2 c3 d4 e5 f6 g7 h8")).toHaveLength(6);
    expect(interpretarBusca("x".repeat(500))[0]!.texto).toHaveLength(120);
  });

  it("telefone com máscara e espaço vale como UMA palavra numérica, só pelos dígitos", () => {
    for (const t of ["(66) 99988-7766", "+55 66 99988-7766", "66 9 9988 7766"]) {
      const p = interpretarBusca(t);
      expect(p).toHaveLength(1);
      expect(p[0]!.digitos).toBe(soDigitos(t));
      expect(p[0]!.texto).toBe(soDigitos(t));
    }
  });

  it("CNPJ com e sem máscara vira os mesmos 14 dígitos", () => {
    expect(interpretarBusca("12.345.678/0001-90")[0]!.digitos).toBe("12345678000190");
    expect(interpretarBusca("12345678000190")[0]!.digitos).toBe("12345678000190");
  });

  it("número junto de texto: o número é comparado pelos dígitos, o resto por texto", () => {
    const p = interpretarBusca("fazenda 12.345.678/0001-90");
    expect(p.map((x) => x.digitos)).toEqual([null, "12345678000190"]);
  });

  it("e-mail fica como palavra de texto (o @ não vira número)", () => {
    const p = interpretarBusca("Jose.Silva@Fazenda.com");
    expect(p).toHaveLength(1);
    expect(p[0]!.digitos).toBeNull();
    expect(p[0]!.texto).toBe("jose.silva@fazenda.com");
  });

  it("pontuação solta na ponta da palavra é descartada", () => {
    expect(interpretarBusca("silva, jose;").map((x) => x.texto)).toEqual(["silva", "jose"]);
  });
});

describe("variantesDeTelefone", () => {
  it("com 9: também sem o 9 (linha antiga)", () => {
    expect(variantesDeTelefone("66999887766")).toEqual(expect.arrayContaining(["66999887766", "6699887766"]));
  });
  it("sem 9: também com o 9", () => {
    expect(variantesDeTelefone("6699887766")).toEqual(expect.arrayContaining(["6699887766", "66999887766"]));
  });
  it("com 55 na frente: cobre também sem o 55", () => {
    const v = variantesDeTelefone("5566999887766");
    expect(v).toEqual(expect.arrayContaining(["5566999887766", "66999887766", "6699887766"]));
  });
  it("pedaço curto vale só ele mesmo", () => {
    expect(variantesDeTelefone("99988")).toEqual(["99988"]);
  });
});
