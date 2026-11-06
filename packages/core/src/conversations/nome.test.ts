import { describe, expect, it } from "vitest";
import { nomeDaConversa, nomeDePessoaValido, nomeSugeridoDaConversa, ROTULO_CONVERSA_SEM_NUMERO } from "./nome";

/**
 * Ordem do nome da conversa pedida pelo dono (28/09): contato cadastrado >
 * agenda do celular > pushName (só de mensagem recebida) > número.
 */
const base = { contatoNome: null, nomeAgenda: null, externalName: null, externalNumber: "+5565999991111" };

describe("nomeDaConversa — os 4 níveis", () => {
  it("1º o contato cadastrado, mesmo com agenda e pushName", () => {
    expect(nomeDaConversa({ ...base, contatoNome: "Maicon (cadastro)", nomeAgenda: "Maicon Agenda", externalName: "Mai" })).toBe("Maicon (cadastro)");
  });
  it("2º a agenda do celular, na frente do pushName", () => {
    expect(nomeDaConversa({ ...base, nomeAgenda: "Maicon Agenda", externalName: "Mai" })).toBe("Maicon Agenda");
  });
  it("3º o pushName da outra pessoa", () => {
    expect(nomeDaConversa({ ...base, externalName: "Mai" })).toBe("Mai");
  });
  it("4º só o número", () => {
    expect(nomeDaConversa(base)).toBe("+5565999991111");
  });
  it("conversa @lid sem nome não mostra o id anônimo", () => {
    expect(nomeDaConversa({ ...base, externalNumber: "123456789@lid" })).toBe(ROTULO_CONVERSA_SEM_NUMERO);
    expect(nomeDaConversa({ ...base, externalNumber: null })).toBe("Desconhecido");
  });
  it("nome que não é nome (número, 'Você', rótulo antigo) cai para o nível seguinte", () => {
    expect(nomeDaConversa({ ...base, nomeAgenda: "5565999991111", externalName: "Mai" })).toBe("Mai");
    expect(nomeDaConversa({ ...base, externalName: "Você" })).toBe("+5565999991111");
    expect(nomeDaConversa({ ...base, externalName: "Conversa do WhatsApp · 1234", externalNumber: "1234@lid" })).toBe(ROTULO_CONVERSA_SEM_NUMERO);
    expect(nomeDaConversa({ ...base, contatoNome: "  " , externalName: "Mai" })).toBe("Mai");
  });
});

describe("nomeDePessoaValido / nomeSugeridoDaConversa", () => {
  it("recusa vazio, número, id de @lid e 'Você'; aceita nome com acento e emoji", () => {
    for (const n of [null, "", "  ", "+55 (65) 99999-1111", "123456789012345", "Você", "voce"]) {
      expect(nomeDePessoaValido(n)).toBeNull();
    }
    expect(nomeDePessoaValido("  Salés 🌞 ")).toBe("Salés 🌞");
  });
  it("sugere agenda > pushName; sem nome, null (o cadastro começa vazio)", () => {
    expect(nomeSugeridoDaConversa({ nomeAgenda: "Agenda", externalName: "Perfil" })).toBe("Agenda");
    expect(nomeSugeridoDaConversa({ nomeAgenda: null, externalName: "Perfil" })).toBe("Perfil");
    expect(nomeSugeridoDaConversa({ nomeAgenda: null, externalName: "Conversa do WhatsApp · 1234" })).toBeNull();
  });
});
