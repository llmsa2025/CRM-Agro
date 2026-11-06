import { describe, expect, it } from "vitest";
import { proveniencia } from "./proveniencia-empresa";

describe("proveniencia da empresa (Company.enrichment)", () => {
  it("lê fonte e data por campo, dados públicos e sócios", () => {
    const r = proveniencia({
      campos: { email: { valor: "a@b.com", fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00Z", confianca: "alta" } },
      publico: [{ rotulo: "Razão social", valor: "AGRO LTDA", fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00Z" }],
      socios: [{ nome: "MARIA SILVA", qualificacao: "Sócio", cpfExibicao: "***.982.247-**" }],
    });
    expect(r.proveniencia.email).toEqual({ fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00Z" });
    expect(r.dadosPublicos).toHaveLength(1);
    expect(r.socios).toEqual([{ nome: "MARIA SILVA", qualificacao: "Sócio", cpfExibicao: "***.982.247-**" }]);
  });

  it("JSON vazio, de outra forma ou com campos incompletos não derruba: só some", () => {
    for (const lixo of [null, undefined, 5, "x", [], { campos: 3, publico: "x", socios: 7 }, { campos: { email: { valor: "x" } }, publico: [{ rotulo: "A" }], socios: [{}] }]) {
      expect(proveniencia(lixo)).toEqual({ proveniencia: {}, dadosPublicos: [], socios: [], situacao: null });
    }
  });

  it("situação: lê a que o CRM Agro guardou; sem ela, tira dos dados públicos; sem nenhuma, fica null", () => {
    const guardada = proveniencia({ situacao: { ativa: false, descricao: "BAIXADA", consultadoEm: "2026-10-12T10:00:00Z", fonteRotulo: "Minha Receita" } });
    expect(guardada.situacao).toEqual({ ativa: false, descricao: "BAIXADA", consultadoEm: "2026-10-12T10:00:00Z" });
    const dosDadosPublicos = (valor: string) => proveniencia({ publico: [{ rotulo: "Situação cadastral", valor, fonteRotulo: "CNPJá", consultadoEm: "2026-10-01T10:00:00Z" }] }).situacao;
    expect(dosDadosPublicos("Ativa")).toMatchObject({ ativa: true });
    expect(dosDadosPublicos("BAIXADA")).toMatchObject({ ativa: false });
    expect(proveniencia({ campos: {} }).situacao).toBeNull();
    expect(proveniencia({ situacao: { ativa: "sim" } }).situacao).toBeNull();
  });
});
