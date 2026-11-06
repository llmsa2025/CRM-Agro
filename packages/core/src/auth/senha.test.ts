import { describe, it, expect } from "vitest";
import { motivoSenhaFraca, SENHA_MAX } from "./senha";

/**
 * Regras de senha nova do cadastro com e-mail e senha: barreira contra o
 * óbvio, com mensagem clara. Puro: sem banco.
 */
const ctx = { email: "joao.silva@fazendaboavista.example", nomes: ["João da Silva", "Fazenda Boa Vista"] };

describe("motivoSenhaFraca", () => {
  it("aceita senha razoável (frase, mistura)", () => {
    expect(motivoSenhaFraca("colheita de soja em marco", ctx)).toBeNull();
    expect(motivoSenhaFraca("Trator#Verde42", ctx)).toBeNull();
    expect(motivoSenhaFraca("k9$Lp2@vXq", ctx)).toBeNull();
  });

  it("recusa curta e longa demais", () => {
    expect(motivoSenhaFraca("Ab1!xyz", ctx)).toMatch(/ao menos 8/);
    expect(motivoSenhaFraca("a".repeat(SENHA_MAX + 1), ctx)).toMatch(/no máximo/);
  });

  it("recusa o e-mail, a parte antes do @, o nome e o nome da empresa (e com número no fim)", () => {
    for (const s of [
      "joao.silva@fazendaboavista.example",
      "JoaoSilva",
      "joao.silva",
      "joao.silva123",
      "2026joaosilva",
      "fazendaboavista",
      "Fazenda Boa Vista 1",
      "joao da silva",
      "silva2026",
    ]) {
      expect(motivoSenhaFraca(s, ctx), s).toMatch(/e-mail|nome/);
    }
  });

  it("recusa repetição, sequência e fileira do teclado", () => {
    for (const s of ["aaaaaaaa", "11111111", "12345678", "87654321", "abcdefgh", "qwertyuiop", "asdfghjk", "0987654321"]) {
      expect(motivoSenhaFraca(s, ctx), s).toMatch(/fácil de adivinhar/);
    }
  });

  it("recusa senha comum e palavra comum + número/símbolo", () => {
    for (const s of ["senha123", "Senha@2026", "password1", "Passw0rd!", "mudar123", "CRM Agro@2026", "admin1234", "iloveyou", "flamengo", "1q2w3e4r"]) {
      expect(motivoSenhaFraca(s, ctx), s).toMatch(/comum/);
    }
  });

  it("recusa senha só de números curta (data, telefone, CPF)", () => {
    expect(motivoSenhaFraca("15081990", ctx)).toMatch(/só de números/);
    expect(motivoSenhaFraca("65 99999-1234", ctx)).toMatch(/só de números/);
  });

  it("sem contexto, ainda recusa o óbvio", () => {
    expect(motivoSenhaFraca("12345678")).not.toBeNull();
    expect(motivoSenhaFraca("pomar-de-laranja")).toBeNull();
  });
});
