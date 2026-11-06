import { describe, expect, it } from "vitest";
import { adicionarDestino, ordenarPorPosicao, removerDestino, todosDestinos } from "./destinos";

describe("destinos da saída da condição", () => {
  it("o primeiro destino vira o principal e os outros se somam, sem repetir", () => {
    let s = adicionarDestino(null, undefined, "A");
    expect(s).toEqual({ principal: "A", mais: [] });
    s = adicionarDestino(s.principal, s.mais, "B");
    s = adicionarDestino(s.principal, s.mais, "B");
    expect(s).toEqual({ principal: "A", mais: ["B"] });
    expect(todosDestinos(s.principal, s.mais)).toEqual(["A", "B"]);
  });

  it("remover o principal promove o próximo; remover um extra não mexe nos outros", () => {
    expect(removerDestino("A", ["B", "C"], "A")).toEqual({ principal: "B", mais: ["C"] });
    expect(removerDestino("A", ["B", "C"], "B")).toEqual({ principal: "A", mais: ["C"] });
    expect(removerDestino("A", [], "A")).toEqual({ principal: null, mais: [] });
  });

  it("ordena de cima para baixo no mapa", () => {
    const pos = new Map([["A", { x: 300, y: 200 }], ["B", { x: 300, y: 50 }], ["C", { x: 100, y: 200 }]]);
    expect(ordenarPorPosicao(["A", "B", "C"], pos)).toEqual(["B", "C", "A"]);
  });
});
