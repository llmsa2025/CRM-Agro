import { describe, expect, it } from "vitest";
import { alternar, dataCurta, rotuloDaConfianca, selecaoInicial, textoDoAplicar, trocasMarcadas, type ItemDaTela } from "./enriquecer-empresa";

const item = (id: string, campo: string, acao: ItemDaTela["acao"], confianca: ItemDaTela["confianca"] = "alta"): ItemDaTela => ({ id, campo, acao, confianca });

describe("seleção inicial: nada que já existe é trocado sem a pessoa marcar", () => {
  const itens = [
    item("email-1", "email", "preencher", "alta"),
    item("email-2", "email", "preencher", "media"),
    item("tel-1", "telefone", "trocar", "alta"), // já tem outro telefone
    item("ie-1", "ie", "preencher", "baixa"),
    item("cnae-1", "cnae", "igual"),
    item("cidade-1", "cidade", "preencher", "media"),
  ];
  it("marca só o melhor 'preencher' de cada campo e ignora trocar, baixa e igual", () => {
    expect([...selecaoInicial(itens)].sort()).toEqual(["cidade-1", "email-1"]);
  });
  it("trocar nunca vem marcado", () => {
    expect(selecaoInicial([item("a", "email", "trocar")]).size).toBe(0);
  });
});

describe("alternar: um valor por campo", () => {
  const itens = [item("e1", "email", "preencher"), item("e2", "email", "preencher", "media"), item("t1", "telefone", "trocar"), item("c1", "cnae", "igual")];
  it("marcar um tira o outro do mesmo campo; desmarcar deixa vazio", () => {
    let s = selecaoInicial(itens);
    expect([...s]).toEqual(["e1"]);
    s = alternar(s, itens, "e2");
    expect([...s]).toEqual(["e2"]);
    s = alternar(s, itens, "e2");
    expect(s.size).toBe(0);
  });
  it("marcar uma troca conta como troca; item 'igual' não marca", () => {
    const s = alternar(new Set(), itens, "t1");
    expect(trocasMarcadas(s, itens)).toBe(1);
    expect(alternar(new Set(), itens, "c1").size).toBe(0);
    expect(alternar(new Set(), itens, "inexistente").size).toBe(0);
  });
});

describe("textos", () => {
  it("data em São Paulo e rótulos", () => {
    expect(dataCurta("2026-10-05T12:00:00.000Z")).toBe("05/10/2026");
    expect(dataCurta("2026-10-06T01:30:00.000Z")).toBe("05/10/2026"); // ainda dia 5 em São Paulo
    expect(dataCurta("lixo")).toBe("");
    expect(rotuloDaConfianca("media")).toBe("Confiança média");
  });
  it("botão de aplicar", () => {
    expect(textoDoAplicar(0, false)).toBe("Nada marcado");
    expect(textoDoAplicar(0, true)).toBe("Guardar dados públicos");
    expect(textoDoAplicar(1, false)).toBe("Aplicar 1 campo");
    expect(textoDoAplicar(3, true)).toBe("Aplicar 3 campos");
    for (const t of [textoDoAplicar(2, false), rotuloDaConfianca("baixa")]) expect(t).not.toMatch(/[—–]/);
  });
});
