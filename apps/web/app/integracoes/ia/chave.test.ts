import { describe, expect, it } from "vitest";
import { mensagemDoMotivoDaChave, mostrarCampoDaChave } from "./chave";

describe("texto do motivo da chave de IA", () => {
  const motivos = ["formato", "token_oauth", "espaco", "recusada", "sem_acesso", "limite", "indisponivel", "rede"] as const;

  it("cada motivo tem um texto próprio e nenhum repete o genérico", () => {
    const textos = new Set(motivos.map((m) => mensagemDoMotivoDaChave("anthropic", m)));
    expect(textos.size).toBe(motivos.length);
    for (const t of textos) expect(t).not.toBe("Verifique a chave.");
  });

  it("sem motivo (ou desconhecido) cai no texto de antes", () => {
    expect(mensagemDoMotivoDaChave("anthropic", undefined)).toBe("Verifique a chave.");
    expect(mensagemDoMotivoDaChave("anthropic", "qualquer-coisa")).toBe("Verifique a chave.");
  });

  it("nomeia o provedor e diz onde gerar a chave", () => {
    expect(mensagemDoMotivoDaChave("anthropic", "recusada")).toContain("Anthropic");
    expect(mensagemDoMotivoDaChave("openai", "recusada")).toContain("OpenAI");
    expect(mensagemDoMotivoDaChave("anthropic", "formato")).toContain("console.anthropic.com");
    expect(mensagemDoMotivoDaChave("openai", "formato")).toContain("platform.openai.com");
    expect(mensagemDoMotivoDaChave("anthropic", "formato")).toContain("sk-ant-");
  });

  it("o token do Claude Code é explicado como diferente de chave de API", () => {
    expect(mensagemDoMotivoDaChave("anthropic", "token_oauth")).toContain("Claude Code");
  });

  it("os textos não têm travessão e não vazam a palavra 'chave' em inglês", () => {
    for (const m of motivos) {
      const t = mensagemDoMotivoDaChave("glm", m);
      expect(t).not.toMatch(/[—–]/);
      expect(t).not.toMatch(/\bapi key\b/i);
    }
  });
});

describe("campo para colar a chave", () => {
  it("sem chave ou com chave que deu erro, o campo aparece", () => {
    expect(mostrarCampoDaChave({ connected: false, trocando: false })).toBe(true);
  });
  it("com a chave conectada e testada, o campo some", () => {
    expect(mostrarCampoDaChave({ connected: true, trocando: false })).toBe(false);
  });
  it("em 'Trocar a chave', o campo volta", () => {
    expect(mostrarCampoDaChave({ connected: true, trocando: true })).toBe(true);
  });
});
