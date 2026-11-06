import { describe, expect, it } from "vitest";
import { LIMITE_INSTAGRAM_MAX, LIMITE_INSTAGRAM_PADRAO, limiteDeCaptura } from "./captacao-limite";

describe("limiteDeCaptura", () => {
  it("aceita número ou texto dentro do intervalo", () => {
    expect(limiteDeCaptura(50)).toBe(50);
    expect(limiteDeCaptura("50")).toBe(50);
    expect(limiteDeCaptura(" 120 ")).toBe(120);
  });
  it("arredonda para baixo", () => {
    expect(limiteDeCaptura(49.9)).toBe(49);
    expect(limiteDeCaptura("12,7")).toBe(12);
  });
  it("respeita o mínimo de 1 e o teto", () => {
    expect(limiteDeCaptura(0)).toBe(1);
    expect(limiteDeCaptura(-5)).toBe(1);
    expect(limiteDeCaptura(1000)).toBe(LIMITE_INSTAGRAM_MAX);
    expect(LIMITE_INSTAGRAM_MAX).toBe(300);
  });
  it("vazio ou lixo volta ao padrão", () => {
    expect(limiteDeCaptura("")).toBe(LIMITE_INSTAGRAM_PADRAO);
    expect(limiteDeCaptura("abc")).toBe(LIMITE_INSTAGRAM_PADRAO);
    expect(limiteDeCaptura(null)).toBe(LIMITE_INSTAGRAM_PADRAO);
    expect(limiteDeCaptura(NaN)).toBe(LIMITE_INSTAGRAM_PADRAO);
    expect(limiteDeCaptura(Infinity)).toBe(LIMITE_INSTAGRAM_PADRAO);
  });
});
