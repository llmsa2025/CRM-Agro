import { describe, expect, it } from "vitest";
import { CANAIS_DA_TELA, CANAIS_EM_BREVE, canalAbreEmIntegracoes, canalEmBreve, contasDeIntegracoes, semCanaisEmBreve } from "../app/integracoes/canais/abas";

describe("canais em breve", () => {
  it("o LinkedIn está em breve e os outros canais conectam normalmente", () => {
    expect(canalEmBreve("linkedin")).toBe(true);
    for (const c of ["whatsapp", "instagram", "email"]) expect(canalEmBreve(c)).toBe(false);
  });
  it("só canais que existem na tela podem ficar em breve", () => {
    for (const c of CANAIS_EM_BREVE) expect(CANAIS_DA_TELA).toContain(c);
  });
  it("canal desconhecido não é tratado como em breve", () => {
    expect(canalEmBreve("telegram")).toBe(false);
  });
});

describe("contas que as telas mostram", () => {
  const contas = [
    { id: "1", canal: "whatsapp" },
    { id: "2", canal: "linkedin" },
    { id: "3", canal: "instagram" },
    { id: "4", canal: "email" },
  ];

  it("tira a conta de canal em breve (LinkedIn) e mantém a ordem das outras", () => {
    expect(semCanaisEmBreve(contas).map((c) => c.id)).toEqual(["1", "3", "4"]);
  });
  it("não mexe na lista de entrada e devolve tudo quando não há canal em breve", () => {
    const antes = [...contas];
    semCanaisEmBreve(contas);
    expect(contas).toEqual(antes);
    expect(semCanaisEmBreve(contas.filter((c) => c.canal !== "linkedin"))).toHaveLength(3);
  });
  it("lista vazia continua vazia", () => {
    expect(semCanaisEmBreve([])).toEqual([]);
  });
});

describe("canais em Integrações", () => {
  it("o LinkedIn só abre quando o app do LinkedIn está configurado; os outros canais sempre abrem", () => {
    expect(canalAbreEmIntegracoes("linkedin", false)).toBe(false);
    expect(canalAbreEmIntegracoes("linkedin", true)).toBe(true);
    for (const c of ["whatsapp", "instagram", "email"]) {
      expect(canalAbreEmIntegracoes(c, false)).toBe(true);
      expect(canalAbreEmIntegracoes(c, true)).toBe(true);
    }
  });

  const contas = [
    { id: "1", canal: "whatsapp", provider: "evolution" },
    { id: "2", canal: "linkedin", provider: "linkedin_browser" },
    { id: "3", canal: "linkedin", provider: "linkedin_official" },
    { id: "4", canal: "instagram", provider: "instagram_browser" },
  ];

  it("sem o app do LinkedIn, nenhuma conta de LinkedIn aparece", () => {
    expect(contasDeIntegracoes(contas, false).map((c) => c.id)).toEqual(["1", "4"]);
  });
  it("com o app do LinkedIn, só a conta oficial aparece (a antiga, pela extensão, fica escondida)", () => {
    expect(contasDeIntegracoes(contas, true).map((c) => c.id)).toEqual(["1", "3", "4"]);
  });
  it("em Conversas o LinkedIn continua sem conta nenhuma, mesmo com o app configurado (a caixa ainda não existe)", () => {
    expect(semCanaisEmBreve(contas).map((c) => c.id)).toEqual(["1", "4"]);
  });
});
