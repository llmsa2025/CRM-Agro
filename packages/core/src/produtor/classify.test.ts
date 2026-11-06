import { describe, it, expect } from "vitest";
import { classificaCnae, classificarProdutor, PRODUTOR_REGRA_VERSAO } from "./classify";

describe("classificaCnae — mapeamento de CNAE → categoria", () => {
  it("reconhece produção direta e ambíguos", () => {
    expect(classificaCnae("0115-6/00")).toBe("lavoura_temporaria"); // soja
    expect(classificaCnae("0133400")).toBe("lavoura_permanente"); // café
    expect(classificaCnae("0151201")).toBe("pecuaria"); // bovinos
    expect(classificaCnae("0163600")).toBe("pos_colheita"); // algodoeira (ambíguo)
    expect(classificaCnae("5211701")).toBe("armazem"); // silos (ambíguo)
    expect(classificaCnae("1311100")).toBe("fiacao");
    expect(classificaCnae("6201500")).toBe("outro"); // TI
  });
});

describe("classificarProdutor — regra §2", () => {
  it("produção direta (soja) + IE de produtor rural = produtor", () => {
    const r = classificarProdutor({
      cnaePrincipal: "0115-6/00",
      ies: [{ tipo: "Produtor Rural", habilitada: true }],
      razaoSocial: "Fazenda Boa Terra",
    });
    expect(r.produtorLabel).toBe("produtor");
    expect(r.isProdutor).toBe(true);
    expect(r.regraVersao).toBe(PRODUTOR_REGRA_VERSAO);
    expect(r.evidencias.some((e) => e.includes("IE de produtor"))).toBe(true);
  });

  it("só algodoeira (0163) isolada = provável produtor (confirmar)", () => {
    const r = classificarProdutor({ cnaePrincipal: "0163-6/00" });
    expect(r.produtorLabel).toBe("provavel_produtor");
    expect(r.isProdutor).toBe(false);
  });

  it("armazém isolado mas dono tem produção direta NÃO fica preso em provável", () => {
    const r = classificarProdutor({ cnaePrincipal: "5211-7/01", donoTemProducaoDireta: true });
    // ambíguo + dono-produtor → não cai na regra de "só ambíguas"; score 5+20=25 < 30
    expect(r.produtorLabel).toBe("nao_produtor");
    expect(r.evidencias.some((e) => e.includes("dono"))).toBe(true);
  });

  it("empresa de TI = não produtor", () => {
    const r = classificarProdutor({ cnaePrincipal: "6201-5/00", razaoSocial: "Softwares LTDA" });
    expect(r.produtorLabel).toBe("nao_produtor");
    expect(r.produtorScore).toBe(0);
  });

  it("pecuária secundária + keyword + IE habilitada soma para produtor", () => {
    const r = classificarProdutor({
      cnaePrincipal: "0151-2/01", // +40 produção direta
      cnaesSecundarios: ["0155-5/04"], // +40
      ies: [{ tipo: "IE Normal", habilitada: true }], // +8
      razaoSocial: "Agro Pecuária Rural", // +12
    });
    expect(r.produtorScore).toBeGreaterThanOrEqual(55);
    expect(r.produtorLabel).toBe("produtor");
  });
});
