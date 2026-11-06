import { describe, expect, it } from "vitest";
import { classificarResposta, normalizarResposta, respostaTemTexto } from "./classificar-resposta";

describe("classificarResposta", () => {
  it("normaliza acento, caixa e pontuação", () => {
    expect(normalizarResposta("  Obrigado, Já tenho!! ")).toBe("obrigado ja tenho");
  });

  it("recusa: 'Obrigado, já tenho' e variações são sem interesse", () => {
    for (const t of ["Obrigado, Já tenho", "já tenho fornecedor", "Não tenho interesse", "sem interesse", "Não, obrigado", "não", "N", "não quero", "Não preciso, valeu", "agora não", "pare de mandar mensagem", "me remove da lista", "Já uso outro produto"]) {
      expect(classificarResposta(t), t).toBe("sem_interesse");
    }
  });

  it("interesse: pedidos de preço, proposta e sim", () => {
    for (const t of ["Tenho interesse", "tenho sim", "Quero saber mais", "pode mandar", "Quanto custa?", "qual o valor?", "me manda a proposta", "Interessado!", "Sim", "pode ser", "gostaria de um orçamento", "Me liga amanhã"]) {
      expect(classificarResposta(t), t).toBe("interesse");
    }
  });

  it("a recusa explícita ganha do 'quero'; o interesse claro ganha do 'já tenho'", () => {
    expect(classificarResposta("não quero")).toBe("sem_interesse");
    expect(classificarResposta("Tenho interesse, mas já tenho outro fornecedor")).toBe("interesse");
    expect(classificarResposta("já tenho, mas me manda o preço")).toBe("interesse");
  });

  it("o resto é 'outro': dúvida, assunto diferente, mídia e vazio", () => {
    for (const t of ["Quem é você?", "Bom dia", "Quem passou meu contato?", "[audio]", "", "   ", "Estou viajando, falo depois"]) {
      expect(classificarResposta(t), t).toBe("outro");
    }
  });

  it("palavra inteira: 'preco' não casa dentro de 'preconceito'", () => {
    expect(classificarResposta("isso é preconceito")).toBe("outro");
  });
});

describe("respostaTemTexto", () => {
  it("contém: a palavra em qualquer parte, sem acento nem caixa; várias palavras separadas por vírgula", () => {
    expect(respostaTemTexto(["Obrigado, Já tenho"], "já tenho", "contem")).toBe(true);
    expect(respostaTemTexto(["Obrigado, Já tenho"], "JA TENHO", "contem")).toBe(true);
    expect(respostaTemTexto(["Obrigado"], "já tenho, não preciso", "contem")).toBe(false);
    expect(respostaTemTexto(["não preciso, valeu"], "já tenho, não preciso", "contem")).toBe(true);
    expect(respostaTemTexto(["interessado"], "interess", "contem")).toBe(true); // pedaço de palavra
  });

  it("exato: a resposta inteira é a palavra", () => {
    expect(respostaTemTexto(["Sim."], "sim", "exato")).toBe(true);
    expect(respostaTemTexto(["Sim, já tenho"], "sim", "exato")).toBe(false);
    expect(respostaTemTexto(["bom dia", "SIM"], "sim; ok", "exato")).toBe(true); // cada mensagem sozinha
  });

  it("sem palavra ou sem resposta não casa", () => {
    expect(respostaTemTexto(["sim"], "  ,  ", "contem")).toBe(false);
    expect(respostaTemTexto([], "sim", "contem")).toBe(false);
  });
});
