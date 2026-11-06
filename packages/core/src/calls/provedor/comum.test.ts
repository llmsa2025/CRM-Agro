import { describe, expect, it } from "vitest";
import { SEGREDO_REDIGIDO, confereComSegredo, contemSegredo, fabricarIdDeEvento, iguaisEmTempoConstante, mascararSegredo, redigirSegredos } from "./comum";

const CHAVE = "chave_ABCDEF1234567890";

describe("redigirSegredos", () => {
  it("troca o segredo em qualquer ponto do texto", () => {
    expect(redigirSegredos(`Authorization: Bearer ${CHAVE} e de novo ${CHAVE}`, [CHAVE])).toBe(`Authorization: Bearer ${SEGREDO_REDIGIDO} e de novo ${SEGREDO_REDIGIDO}`);
  });

  it("apanha a forma codificada para URL e em base64", () => {
    const segredo = "chave com espaço/e+barra";
    expect(redigirSegredos(`?k=${encodeURIComponent(segredo)}`, [segredo])).toBe(`?k=${SEGREDO_REDIGIDO}`);
    expect(redigirSegredos(`Basic ${Buffer.from(segredo).toString("base64")}`, [segredo])).toBe(`Basic ${SEGREDO_REDIGIDO}`);
  });

  it("ignora segredo curto demais (confundiria qualquer texto)", () => {
    expect(redigirSegredos("a senha é abc", ["abc"])).toBe("a senha é abc");
  });

  it("sem segredos, o texto fica como está", () => {
    expect(redigirSegredos("nada aqui", [])).toBe("nada aqui");
  });
});

describe("contemSegredo: varredura funda", () => {
  it("acha em texto, objeto, lista aninhada e em chave de objeto", () => {
    expect(contemSegredo(`oi ${CHAVE}`, [CHAVE])).toBe(true);
    expect(contemSegredo({ a: { b: [1, { c: CHAVE }] } }, [CHAVE])).toBe(true);
    expect(contemSegredo({ [CHAVE]: 1 }, [CHAVE])).toBe(true);
    expect(contemSegredo({ a: "limpo" }, [CHAVE])).toBe(false);
    expect(contemSegredo(null, [CHAVE])).toBe(false);
    expect(contemSegredo(undefined, [CHAVE])).toBe(false);
  });

  it("acha na mensagem, na pilha, no nome, em campo próprio e na causa de um Error", () => {
    expect(contemSegredo(new Error(`falhou com ${CHAVE}`), [CHAVE])).toBe(true);
    expect(contemSegredo(Object.assign(new Error("x"), { detalhe: CHAVE }), [CHAVE])).toBe(true);
    expect(contemSegredo(new Error("x", { cause: new Error(CHAVE) }), [CHAVE])).toBe(true);
    const comNome = new Error("x");
    comNome.name = `Erro_${CHAVE}`;
    expect(contemSegredo(comNome, [CHAVE])).toBe(true);
    expect(contemSegredo(new Error("limpo"), [CHAVE])).toBe(false);
  });

  it("acha o que só aparece no toJSON", () => {
    expect(contemSegredo({ toJSON: () => ({ k: CHAVE }) }, [CHAVE])).toBe(true);
    expect(contemSegredo({ toJSON: () => { throw new Error("quebrou"); } }, [CHAVE])).toBe(false);
  });

  it("acha a forma codificada e não entra em laço com referência circular", () => {
    expect(contemSegredo(`https://x/?k=${encodeURIComponent("com espaço e +")}`, ["com espaço e +"])).toBe(true);
    const circular: Record<string, unknown> = { a: 1 };
    circular.eu = circular;
    expect(contemSegredo(circular, [CHAVE])).toBe(false);
    circular.chave = CHAVE;
    expect(contemSegredo(circular, [CHAVE])).toBe(true);
  });

  it("segredo curto não conta (evita falso positivo)", () => {
    expect(contemSegredo("abc abc", ["abc"])).toBe(false);
  });
});

describe("peças de verificação", () => {
  it("comparação em tempo constante", () => {
    expect(iguaisEmTempoConstante("abc", "abc")).toBe(true);
    expect(iguaisEmTempoConstante("abc", "abd")).toBe(false);
    expect(iguaisEmTempoConstante("abc", "abcd")).toBe(false);
    expect(iguaisEmTempoConstante("", "")).toBe(true);
    expect(iguaisEmTempoConstante("a".repeat(1000), "a".repeat(1001))).toBe(false);
  });

  it("confere com o segredo atual ou com o anterior (janela de rotação)", () => {
    expect(confereComSegredo("novo", { atual: "novo" })).toBe(true);
    expect(confereComSegredo("velho", { atual: "novo", anterior: "velho" })).toBe(true);
    expect(confereComSegredo("velho", { atual: "novo" })).toBe(false);
    expect(confereComSegredo("outro", { atual: "novo", anterior: "velho" })).toBe(false);
    expect(confereComSegredo(undefined, { atual: "novo" })).toBe(false);
    expect(confereComSegredo("", { atual: "novo" })).toBe(false);
    expect(confereComSegredo("novo", null)).toBe(false);
  });

  it("id de evento fabricado: mesmo fato, mesmo id; fatos diferentes, ids diferentes; sem ambiguidade nas partes", () => {
    const a = fabricarIdDeEvento("tok1", "PAID", "2026-10-06");
    expect(fabricarIdDeEvento("tok1", "PAID", "2026-10-06")).toBe(a);
    expect(fabricarIdDeEvento("tok1", "PAID", "2026-10-07")).not.toBe(a);
    expect(fabricarIdDeEvento("tok1", "REFUNDED", "2026-10-06")).not.toBe(a);
    // "ab","c" não pode colidir com "a","bc"
    expect(fabricarIdDeEvento("ab", "c")).not.toBe(fabricarIdDeEvento("a", "bc"));
    expect(a).toMatch(/^h_[0-9a-f]{40}$/);
  });
});

describe("máscara de credencial", () => {
  it("só os 4 últimos, e só se o segredo for longo", () => {
    expect(mascararSegredo(undefined)).toEqual({ preenchido: false, ultimos4: null });
    expect(mascararSegredo("")).toEqual({ preenchido: false, ultimos4: null });
    expect(mascararSegredo("abcdefghijkl")).toEqual({ preenchido: true, ultimos4: "ijkl" }); // 12 caracteres
    expect(mascararSegredo("abcdefghijk")).toEqual({ preenchido: true, ultimos4: null }); // 11: curto demais
  });
});
