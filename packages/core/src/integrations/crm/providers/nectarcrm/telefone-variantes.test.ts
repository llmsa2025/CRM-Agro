/** N3: variantes de busca do telefone (plano §2.4), a ordem pela conta e a codificação no endereço. */
import { describe, expect, it } from "vitest";
import { segmento } from "./client";
import {
  FORMATO_DA_VARIANTE,
  formatoDoTelefone,
  mesmoTelefone,
  ordenarVariantes,
  soDigitos,
  telefoneNoFormato,
  variantesDoTelefone,
} from "./telefone";

describe("variantesDoTelefone", () => {
  it("celular BR: as 7 variantes da §2.4, nesta ordem", () => {
    expect(variantesDoTelefone("+5562999998888")).toEqual([
      "+5562999998888",
      "5562999998888",
      "62999998888",
      "(62) 99999-8888",
      "(62) 999998888",
      "6299998888",
      "(62) 9999-8888",
    ]);
  });

  it("FORMATO_DA_VARIANTE acompanha a ordem das variantes", () => {
    const variantes = variantesDoTelefone("+5562999998888");
    expect(FORMATO_DA_VARIANTE).toHaveLength(7);
    variantes.forEach((v, i) => expect(formatoDoTelefone(v)).toBe(FORMATO_DA_VARIANTE[i]));
  });

  it("fixo BR (8 dígitos): e164, 55, ddd e (DD) XXXX-XXXX", () => {
    expect(variantesDoTelefone("+556232221111")).toEqual(["+556232221111", "556232221111", "6232221111", "(62) 3222-1111"]);
  });

  it("número de fora ou fora do padrão: só o próprio E.164", () => {
    expect(variantesDoTelefone("+14155550123")).toEqual(["+14155550123"]);
    expect(variantesDoTelefone("+5562123")).toEqual(["+5562123"]);
    expect(variantesDoTelefone("62999998888")).toEqual(["62999998888"]);
  });

  it("sem repetição dentro da lista", () => {
    const v = variantesDoTelefone("+5511987654321");
    expect(new Set(v).size).toBe(v.length);
  });
});

describe("ordenarVariantes", () => {
  const variantes = variantesDoTelefone("+5562999998888");

  it("põe primeiro o formato mais comum da conta, do maior para o menor", () => {
    const ordenadas = ordenarVariantes(variantes, { parenteses_hifen: 30, ddd: 15, e164: 5 });
    expect(ordenadas.slice(0, 3)).toEqual(["(62) 99999-8888", "62999998888", "+5562999998888"]);
    expect(ordenadas).toHaveLength(7);
    expect(new Set(ordenadas)).toEqual(new Set(variantes));
  });

  it("empate mantém a ordem original; sem distribuição, nada muda", () => {
    expect(ordenarVariantes(variantes, {})).toEqual(variantes);
    const empate = ordenarVariantes(variantes, { ddd: 10, "55": 10 });
    expect(empate.slice(0, 2)).toEqual(["5562999998888", "62999998888"]);
  });

  it("não altera a lista de entrada", () => {
    const copia = [...variantes];
    ordenarVariantes(variantes, { sem_nono: 99 });
    expect(variantes).toEqual(copia);
  });
});

describe("codificação no endereço", () => {
  it("o segmento de cada variante codifica +, ( ), espaço", () => {
    const codificadas = variantesDoTelefone("+5562999998888").map(segmento);
    expect(codificadas[0]).toBe("%2B5562999998888");
    expect(codificadas[3]).toBe("%2862%29%2099999-8888");
    expect(codificadas[6]).toBe("%2862%29%209999-8888");
    for (const c of codificadas) {
      expect(c).not.toMatch(/[+() ]/);
    }
  });
});

describe("telefoneNoFormato e mesmoTelefone", () => {
  it("escreve o número no formato preferido; formato inexistente cai no E.164", () => {
    expect(telefoneNoFormato("+5562999998888", "parenteses_hifen")).toBe("(62) 99999-8888");
    expect(telefoneNoFormato("+5562999998888", "ddd")).toBe("62999998888");
    expect(telefoneNoFormato("+5562999998888", "outro")).toBe("+5562999998888");
    expect(telefoneNoFormato("+14155550123", "parenteses_hifen")).toBe("+14155550123");
  });

  it("reconhece o mesmo número em qualquer variante ou escrito com espaços", () => {
    const v = variantesDoTelefone("+5562999998888");
    expect(mesmoTelefone("(62) 99999-8888", v)).toBe(true);
    expect(mesmoTelefone("62 99999 8888", v)).toBe(true);
    expect(mesmoTelefone("6299998888", v)).toBe(true);
    expect(mesmoTelefone("(62) 99999-7777", v)).toBe(false);
    expect(mesmoTelefone("", v)).toBe(false);
    expect(soDigitos("+55 (62) 9")).toBe("55629");
  });
});
