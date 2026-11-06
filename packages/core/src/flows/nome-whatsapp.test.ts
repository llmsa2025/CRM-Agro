import { describe, expect, it } from "vitest";
import { limparNomeDoWhatsApp } from "./nome-whatsapp";

describe("limparNomeDoWhatsApp", () => {
  it("aceita nome junto ou com espaço, com acento e nome curto", () => {
    for (const [entrada, saida] of [
      ["Maria Silva", "Maria Silva"],
      ["MariaSilva", "MariaSilva"],
      ["  Maria   Silva ", "Maria Silva"],
      ["Zé", "Zé"],
      ["José-Maria D'Ávila", "José-Maria D'Ávila"],
      ["Dr. Carlos", "Dr. Carlos"],
      ["Fazenda 3 Irmãos", "Fazenda 3 Irmãos"],
    ] as const) expect(limparNomeDoWhatsApp(entrada)).toBe(saida);
  });

  it("tira emoji e símbolo e fica com o nome", () => {
    expect(limparNomeDoWhatsApp("João 🌾")).toBe("João");
    expect(limparNomeDoWhatsApp("✨ Ana Paula ✨")).toBe("Ana Paula");
    expect(limparNomeDoWhatsApp("João ❤️ Silva")).toBe("João Silva");
    expect(limparNomeDoWhatsApp("(Carlos) 👍🏽")).toBe("Carlos");
    expect(limparNomeDoWhatsApp("~ Pedro ~")).toBe("Pedro");
  });

  it("recusa o que não é nome: um caractere, só emoji, só símbolo, só número, vazio", () => {
    for (const ruim of ["A", "🌾", "😀😀", "❤️", "..", "~", "---", "123", "+55 66 99999-0000", "", "   ", null, undefined]) {
      expect(limparNomeDoWhatsApp(ruim)).toBeNull();
    }
  });
});
