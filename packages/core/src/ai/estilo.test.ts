import { describe, expect, it } from "vitest";
import { REGRA_ESTILO_HUMANO, limparEstiloIA } from "./estilo";

describe("limparEstiloIA", () => {
  it("troca travessão e meia-risca por vírgula", () => {
    expect(limparEstiloIA("Oi João — tudo bem?")).toBe("Oi João, tudo bem?");
    expect(limparEstiloIA("Oi João—tudo bem?")).toBe("Oi João, tudo bem?");
    expect(limparEstiloIA("das 10 – 12h")).toBe("das 10, 12h");
  });
  it("troca hífen com espaços dos dois lados por vírgula", () => {
    expect(limparEstiloIA("Fazenda Boa Vista - soja e milho")).toBe("Fazenda Boa Vista, soja e milho");
  });
  it("não mexe em hífen dentro de palavra, telefone nem intervalo colado", () => {
    expect(limparEstiloIA("Mande o e-mail da pré-venda")).toBe("Mande o e-mail da pré-venda");
    expect(limparEstiloIA("Ligue (66) 99999-7706")).toBe("Ligue (66) 99999-7706");
    expect(limparEstiloIA("de 10-12h")).toBe("de 10-12h");
  });
  it("não deixa vírgula dupla nem vírgula antes de pontuação", () => {
    expect(limparEstiloIA("Oi, — tudo bem?")).toBe("Oi, tudo bem?");
    expect(limparEstiloIA("Combinado —.")).toBe("Combinado.");
  });
  it("mantém quebras de linha", () => {
    expect(limparEstiloIA("Oi!\n\nTudo bem — e você?")).toBe("Oi!\n\nTudo bem, e você?");
  });
});

describe("REGRA_ESTILO_HUMANO", () => {
  it("proíbe travessão e cita as saídas certas", () => {
    expect(REGRA_ESTILO_HUMANO).toContain("NÃO use travessão");
    expect(REGRA_ESTILO_HUMANO).toContain("vírgula");
  });
});
