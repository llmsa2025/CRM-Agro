import { describe, expect, it } from "vitest";
import { centavosParaReais, reaisParaCentavos, textoDoCusto } from "./fonte-paga";

describe("preço do crédito", () => {
  it("lê reais no jeito brasileiro", () => {
    expect(reaisParaCentavos("")).toBeNull();
    expect(reaisParaCentavos("2")).toBe(200);
    expect(reaisParaCentavos("1,50")).toBe(150);
    expect(reaisParaCentavos("R$ 0,75")).toBe(75);
    expect(reaisParaCentavos("0.5")).toBe(50);
  });
  it("recusa o que não é preço", () => {
    for (const t of ["abc", "-1", "1,234", "1.000,00", "1001", "1,5,2"]) expect(reaisParaCentavos(t)).toBe("invalido");
  });
  it("mostra o custo antes de consultar, com ou sem o preço", () => {
    expect(centavosParaReais(450)).toBe("R$ 4,50");
    expect(textoDoCusto(3, 450)).toBe("3 créditos (cerca de R$ 4,50)");
    expect(textoDoCusto(1, null)).toBe("1 crédito");
    expect(textoDoCusto(1, 0)).toBe("1 crédito (cerca de R$ 0,00)");
  });
  it("sem travessão nem meia-risca", () => {
    expect(textoDoCusto(2, 300)).not.toMatch(/[—–]/);
  });
});
