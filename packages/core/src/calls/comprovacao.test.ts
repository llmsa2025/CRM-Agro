import { describe, it, expect } from "vitest";
import { CHAVE_COMPROVADA, ehAtividadeComprovada, marcarTentativaComprovada } from "./comprovacao";

describe("marcarTentativaComprovada", () => {
  it("escreve a chave sem perder as outras e sem mexer no objeto de entrada", () => {
    const meta = { callId: "c1", status: "completed" };
    const novo = marcarTentativaComprovada(meta, true);
    expect(novo).toEqual({ callId: "c1", status: "completed", comprovada: true });
    expect(meta).toEqual({ callId: "c1", status: "completed" });
    expect(novo).not.toBe(meta);
  });

  it("meta ausente, nula ou que não é objeto vira um objeto só com a chave", () => {
    expect(marcarTentativaComprovada(undefined, true)).toEqual({ comprovada: true });
    expect(marcarTentativaComprovada(null, false)).toEqual({ comprovada: false });
    expect(marcarTentativaComprovada([1, 2], true)).toEqual({ comprovada: true });
    expect(marcarTentativaComprovada("texto", true)).toEqual({ comprovada: true });
  });

  it("refazer a projeção troca o valor (true vira false e volta)", () => {
    const comprovada = marcarTentativaComprovada({ callId: "c1" }, true);
    const refeita = marcarTentativaComprovada(comprovada, false);
    expect(refeita).toEqual({ callId: "c1", comprovada: false });
    expect(marcarTentativaComprovada(refeita, true)).toEqual({ callId: "c1", comprovada: true });
  });

  it("é idempotente", () => {
    const uma = marcarTentativaComprovada({ callId: "c1" }, true);
    expect(marcarTentativaComprovada(uma, true)).toEqual(uma);
  });
});

describe("ehAtividadeComprovada", () => {
  it("só o booleano true conta", () => {
    expect(ehAtividadeComprovada({ comprovada: true })).toBe(true);
    expect(ehAtividadeComprovada({ comprovada: false })).toBe(false);
    expect(ehAtividadeComprovada({ comprovada: "true" })).toBe(false);
    expect(ehAtividadeComprovada({ comprovada: 1 })).toBe(false);
    expect(ehAtividadeComprovada({ prova: { comprovada: true } })).toBe(false);
  });

  it("meta que não é objeto simples nunca é comprovada", () => {
    for (const meta of [undefined, null, [true], "comprovada", 7, true]) expect(ehAtividadeComprovada(meta)).toBe(false);
  });

  it("lê o que marcarTentativaComprovada escreve", () => {
    expect(ehAtividadeComprovada(marcarTentativaComprovada({}, true))).toBe(true);
    expect(ehAtividadeComprovada(marcarTentativaComprovada({}, false))).toBe(false);
    expect(CHAVE_COMPROVADA).toBe("comprovada");
  });
});
