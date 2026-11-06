import { describe, expect, it } from "vitest";
import { descreverFalhaDeEnvio, formatarNumeroDoLog, lerNumeroSemWhatsApp, pareceTelefoneFixoBR } from "./falha-legivel";

/** Puro, sem banco: o texto do log quando a Evolution diz que o número não tem WhatsApp. */
describe("falha de envio em português", () => {
  // O erro real do log do Fluxo Teste (número fixo de Mato Grosso).
  const CRU =
    'Evolution sendText 400: {"status":400,"error":"Bad Request","response":{"message":[{"jid":"556633337702@s.whatsapp.net","exists":false,"number":"556633337702"}]}}';

  it("número sem WhatsApp: diz o número e que parece fixo", () => {
    expect(descreverFalhaDeEnvio(CRU)).toBe("Número sem WhatsApp: +55 66 3333-7702 (parece telefone fixo). Passo pulado.");
  });

  it("celular sem WhatsApp não é chamado de fixo", () => {
    const cru = CRU.replaceAll("556633337702", "5566999997705");
    expect(descreverFalhaDeEnvio(cru)).toBe("Número sem WhatsApp: +55 66 99999-7705. Passo pulado.");
  });

  it("corpo cortado em 300 caracteres: com o número inteiro, mostra; cortado no meio dele, não inventa", () => {
    expect(descreverFalhaDeEnvio(CRU.slice(0, CRU.length - 4))).toContain("+55 66 3333-7702"); // perdeu só o fim do JSON, a aspas do número ficou
    expect(descreverFalhaDeEnvio(CRU.slice(0, CRU.length - 5))).toBe("Esse número não tem WhatsApp. Passo pulado."); // sem fecho, pode faltar dígito
    expect(descreverFalhaDeEnvio(CRU.slice(0, CRU.length - 6))).toBe("Esse número não tem WhatsApp. Passo pulado."); // cortou o último dígito
  });

  it("sem número na resposta, ainda diz que não tem WhatsApp", () => {
    expect(descreverFalhaDeEnvio('Evolution sendText 400: {"response":{"message":[{"exists":false}]}}')).toBe("Esse número não tem WhatsApp. Passo pulado.");
  });

  it("qualquer outro erro volta como veio", () => {
    expect(descreverFalhaDeEnvio("400 numero invalido")).toBe("400 numero invalido");
    expect(descreverFalhaDeEnvio('Evolution sendText 500: {"exists":false}')).toBe('Evolution sendText 500: {"exists":false}');
  });

  it("lê o número recusado só quando ele veio inteiro", () => {
    expect(lerNumeroSemWhatsApp(CRU)).toEqual({ numero: "556633337702" });
    expect(lerNumeroSemWhatsApp(CRU.slice(0, CRU.length - 5))).toEqual({ numero: null }); // sem fecho, pode faltar dígito
    expect(lerNumeroSemWhatsApp('Evolution sendMedia 400: {"response":{"message":[{"exists":false,"number":"5565944443333"}]}}')).toEqual({ numero: "5565944443333" });
    expect(lerNumeroSemWhatsApp("Evolution sendText 500: boom")).toBeNull();
    expect(lerNumeroSemWhatsApp("400 numero invalido")).toBeNull();
  });

  it("fixo brasileiro: 8 dígitos começando em 2 a 5", () => {
    expect(pareceTelefoneFixoBR("556633337702")).toBe(true);
    expect(pareceTelefoneFixoBR("5566999997705")).toBe(false);
    expect(pareceTelefoneFixoBR("556699997705")).toBe(false);
  });

  it("formata número fora do padrão só com o +", () => {
    expect(formatarNumeroDoLog("14155550123")).toBe("+14155550123");
  });
});
