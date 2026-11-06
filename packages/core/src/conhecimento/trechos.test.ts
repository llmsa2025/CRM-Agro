import { describe, expect, it } from "vitest";
import { dividirEmTrechos, escolherTrechos, palavrasDaBusca } from "./trechos";

const paragrafo = (tema: string, n = 6) => Array.from({ length: n }, (_, i) => `Sobre ${tema}, ponto ${i + 1}: texto de apoio para encher o parágrafo com palavras diferentes ${i}.`).join(" ");

describe("dividirEmTrechos", () => {
  it("texto vazio não gera trecho", () => {
    expect(dividirEmTrechos("   \n\n  ")).toEqual([]);
  });

  it("junta parágrafos curtos e respeita o tamanho-alvo", () => {
    const texto = Array.from({ length: 12 }, (_, i) => `Linha curta ${i}.`).join("\n\n");
    const t = dividirEmTrechos(texto, 100);
    expect(t.length).toBeGreaterThan(1);
    for (const x of t) expect(x.length).toBeLessThanOrEqual(130);
    expect(t.join("\n\n")).toContain("Linha curta 11.");
  });

  it("parágrafo enorme é partido por frase, sem perder texto", () => {
    const longo = Array.from({ length: 80 }, (_, i) => `Frase número ${i} termina aqui.`).join(" ");
    const t = dividirEmTrechos(longo, 300);
    expect(t.length).toBeGreaterThan(3);
    expect(t.join(" ")).toContain("Frase número 79 termina aqui.");
    for (const x of t) expect(x.length).toBeLessThanOrEqual(450);
  });

  it("uma frase gigante sem pontuação é partida por tamanho", () => {
    const t = dividirEmTrechos("x".repeat(3000), 500);
    expect(t.length).toBeGreaterThanOrEqual(6);
  });
});

describe("palavrasDaBusca", () => {
  it("tira acento, palavra comum e plural simples", () => {
    expect(palavrasDaBusca("Qual é o preço dos adubos orgânicos?")).toEqual(["preco", "adubo", "organico"]);
  });
});

describe("escolherTrechos", () => {
  it("base pequena entra inteira, na ordem, sem busca", () => {
    const r = escolherTrechos(
      [
        { id: "a", titulo: "Sobre a empresa", conteudo: "Vendemos adubo orgânico em Sorriso, MT." },
        { id: "b", titulo: "Preços", conteudo: "O saco de 50 kg custa R$ 120." },
      ],
      "qualquer coisa",
      6000,
    );
    expect(r.completa).toBe(true);
    expect(r.texto).toContain("### Sobre a empresa");
    expect(r.texto).toContain("R$ 120");
    expect(r.usados.map((u) => u.titulo)).toEqual(["Sobre a empresa", "Preços"]);
  });

  it("base grande: traz o trecho que casa com a pergunta e deixa o resto", () => {
    const r = escolherTrechos(
      [
        { id: "a", titulo: "Entrega", conteudo: paragrafo("logística de entrega e frete", 20) },
        { id: "b", titulo: "Garantia", conteudo: `${paragrafo("regras gerais", 20)}\n\nA garantia do inoculante cobre defeito de fabricação por 12 meses.\n\n${paragrafo("outros assuntos", 20)}` },
        { id: "c", titulo: "Institucional", conteudo: paragrafo("história da empresa", 20) },
      ],
      "qual a garantia do inoculante?",
      2500,
    );
    expect(r.completa).toBe(false);
    expect(r.texto.length).toBeLessThanOrEqual(2500 + 200); // títulos e quebras
    expect(r.texto).toContain("garantia do inoculante cobre defeito");
    expect(r.usados.some((u) => u.titulo === "Garantia")).toBe(true);
  });

  it("base grande e nada casa: o começo de cada documento, para não ficar sem nada", () => {
    const r = escolherTrechos(
      [
        { id: "a", titulo: "Doc A", conteudo: `INICIO-A. ${paragrafo("a", 30)}` },
        { id: "b", titulo: "Doc B", conteudo: `INICIO-B. ${paragrafo("b", 30)}` },
      ],
      "zzzz yyyy",
      3000,
    );
    expect(r.completa).toBe(false);
    expect(r.texto).toContain("INICIO-A");
    expect(r.texto).toContain("INICIO-B");
  });

  it("documento só com espaços não conta", () => {
    expect(escolherTrechos([{ id: "a", titulo: "Vazio", conteudo: "  \n " }], "x")).toMatchObject({ texto: "", usados: [] });
  });
});
