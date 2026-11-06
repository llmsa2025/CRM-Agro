import { describe, it, expect } from "vitest";
import { formatarWhatsApp } from "./whatsapp-formato";

const t = (texto: string) => ({ tipo: "texto", texto });

describe("formatarWhatsApp", () => {
  it("negrito, itálico e riscado", () => {
    expect(formatarWhatsApp("Oi *Ana*, _tudo_ ~mal~ bem")).toEqual([
      t("Oi "),
      { tipo: "negrito", filhos: [t("Ana")] },
      t(", "),
      { tipo: "italico", filhos: [t("tudo")] },
      t(" "),
      { tipo: "riscado", filhos: [t("mal")] },
      t(" bem"),
    ]);
  });

  it("aninha negrito e itálico", () => {
    expect(formatarWhatsApp("*_forte_*")).toEqual([{ tipo: "negrito", filhos: [{ tipo: "italico", filhos: [t("forte")] }] }]);
  });

  it("código em linha e em bloco não interpreta o que está dentro", () => {
    expect(formatarWhatsApp("`*x*`")).toEqual([{ tipo: "codigo", texto: "*x*" }]);
    expect(formatarWhatsApp("```linha 1\n*linha 2*```")).toEqual([{ tipo: "codigo", texto: "linha 1\n*linha 2*" }]);
  });

  it("não formata com espaço colado ao marcador, no meio de palavra, nem atravessando linha", () => {
    expect(formatarWhatsApp("2 * 3 * 4")).toEqual([t("2 * 3 * 4")]);
    expect(formatarWhatsApp("snake_case_nome")).toEqual([t("snake_case_nome")]);
    expect(formatarWhatsApp("*a\nb*")).toEqual([t("*a\nb*")]);
    expect(formatarWhatsApp("** **")).toEqual([t("** **")]);
  });

  it("mantém as quebras de linha como texto", () => {
    expect(formatarWhatsApp("*Oi*\n\nTudo bem?")).toEqual([{ tipo: "negrito", filhos: [t("Oi")] }, t("\n\nTudo bem?")]);
  });
});
