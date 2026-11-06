import { describe, expect, it } from "vitest";
import { FORMULARIO_DE_SOCIO_VAZIO, formatarCpfDigitado, montarPedidoDeSocio, rotuloDaConfianca, temNomeESobrenome } from "./captacao-socios";

describe("CPF e nome digitados", () => {
  it("formata o CPF enquanto digita, sem passar de 11 dígitos", () => {
    expect(formatarCpfDigitado("123")).toBe("123");
    expect(formatarCpfDigitado("1234567")).toBe("123.456.7");
    expect(formatarCpfDigitado("12345678901999")).toBe("123.456.789-01");
  });
  it("nome e sobrenome: duas palavras com letras", () => {
    expect(temNomeESobrenome("Maria Silva")).toBe(true);
    expect(temNomeESobrenome("Maria")).toBe(false);
    expect(temNomeESobrenome("  ")).toBe(false);
    expect(temNomeESobrenome("1 2")).toBe(false);
  });
});

describe("montarPedidoDeSocio", () => {
  const base = { ...FORMULARIO_DE_SOCIO_VAZIO, motivo: "indicacao" as const };

  it("CPF vira só dígitos; o pedido não leva a máscara quando há CPF", () => {
    const r = montarPedidoDeSocio({ ...base, cpf: "123.456.789-01", nome: " Maria Silva ", uf: "MT" });
    expect(r).toEqual({ ok: true, pedido: { cpf: "12345678901", nome: "Maria Silva", uf: "MT", motivo: "indicacao", soAtivas: true, limite: 100 } });
  });

  it("sócio escolhido numa lista: vai a máscara e nunca um CPF", () => {
    const r = montarPedidoDeSocio({ ...base, mascara: "***456789**", nome: "Maria Aparecida Silva" });
    expect(r).toMatchObject({ ok: true, pedido: { mascara: "***456789**", nome: "Maria Aparecida Silva" } });
    if (r.ok) expect(r.pedido).not.toHaveProperty("cpf");
  });

  it("avisa o que corrigir", () => {
    expect(montarPedidoDeSocio(base)).toMatchObject({ ok: false, erro: expect.stringMatching(/Informe o CPF/) });
    expect(montarPedidoDeSocio({ ...base, cpf: "123" })).toMatchObject({ ok: false, erro: expect.stringMatching(/11 dígitos/) });
    expect(montarPedidoDeSocio({ ...base, cpf: "12345678901", nome: "Maria" })).toMatchObject({ ok: false, erro: expect.stringMatching(/nome e sobrenome/) });
    expect(montarPedidoDeSocio({ ...base, cpf: "12345678901", cidade: "Sorriso" })).toMatchObject({ ok: false, erro: expect.stringMatching(/estado da cidade/) });
    expect(montarPedidoDeSocio({ ...base, cpf: "12345678901", motivo: "" })).toMatchObject({ ok: false, erro: expect.stringMatching(/por que você busca/) });
  });

  it("quantidade: 1 a 500, vazio volta ao padrão", () => {
    const com = (limite: string) => montarPedidoDeSocio({ ...base, cpf: "12345678901", limite });
    expect(com("9999")).toMatchObject({ pedido: { limite: 500 } });
    expect(com("")).toMatchObject({ pedido: { limite: 100 } });
    expect(com("30")).toMatchObject({ pedido: { limite: 30 } });
  });

  it("textos sem travessão nem meia-risca", () => {
    const textos = [rotuloDaConfianca("alta"), rotuloDaConfianca("media"), rotuloDaConfianca("baixa")].filter(Boolean) as string[];
    for (const t of textos) expect(t).not.toMatch(/[—–]/);
    expect(rotuloDaConfianca(undefined)).toBeNull();
  });
});
