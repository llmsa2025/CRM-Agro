import { describe, it, expect } from "vitest";
import { AGRO_ROTULO, AGRO_SEM_TIPO, AGRO_TIPOS, CATEGORIAS_DA_FOTO, agroFiltroValido, agroTiposValidos } from "./schema";

describe("tipos do agro", () => {
  it("todo tipo tem rótulo", () => {
    for (const t of AGRO_TIPOS) expect(AGRO_ROTULO[t]).toBeTruthy();
    expect(AGRO_ROTULO.pecuaria).toBe("Pecuária");
    expect(AGRO_ROTULO.transportadora).toBe("Transportadora");
  });

  it("a foto pode mostrar gado", () => {
    expect(CATEGORIAS_DA_FOTO).toContain("pecuaria");
  });

  it("agroTiposValidos tira o que não existe, repetidos, e põe na ordem do catálogo", () => {
    expect(agroTiposValidos(["transportadora", "soja", "fazenda", "fazenda", 3, null])).toEqual(["fazenda", "transportadora"]);
    expect(agroTiposValidos(null)).toEqual([]);
  });
});

describe("agroFiltroValido", () => {
  it("aceita um tipo e 'nenhum'", () => {
    for (const t of AGRO_TIPOS) expect(agroFiltroValido(t)).toBe(t);
    expect(agroFiltroValido(AGRO_SEM_TIPO)).toBe("nenhum");
  });

  it("valor estranho vira nada", () => {
    for (const v of ["", "soja", "FAZENDA", undefined, null, 1, ["fazenda"]]) expect(agroFiltroValido(v)).toBeUndefined();
  });
});
