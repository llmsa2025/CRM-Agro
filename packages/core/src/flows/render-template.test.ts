import { describe, it, expect } from "vitest";
import { renderTemplate } from "./executor";

const agora = new Date("2026-10-29T14:00:00Z");

describe("renderTemplate — quebras de linha do autor", () => {
  it("mantém parágrafos e linhas em branco, com variável no meio", () => {
    const texto = "{saudacao}, *{primeiro_nome|tudo bem}*!\n\nAqui é o Marcos.\n\n- Item 1\n- Item 2";
    expect(renderTemplate(texto, { nome: "Ana Souza", now: agora })).toBe("Bom dia, *Ana*!\n\nAqui é o Marcos.\n\n- Item 1\n- Item 2");
  });

  it("variável vazia ainda limpa espaço duplo e pontuação órfã, sem comer a quebra de linha", () => {
    expect(renderTemplate("Oi {primeiro_nome|},\n\nTudo bem?", { nome: "", now: agora })).toBe("Oi,\n\nTudo bem?");
    expect(renderTemplate("Oi   você  \nTudo bem ?", { now: agora })).toBe("Oi você\nTudo bem?");
  });
});
