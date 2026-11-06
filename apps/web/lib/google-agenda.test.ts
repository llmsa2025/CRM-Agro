import { describe, expect, it } from "vitest";
import { codigoDoErroGoogle, destinoDaVolta, lerCookieGoogleAgenda, valorCookieGoogleAgenda } from "./google-agenda";

/** Erro nomeado como os do core (o `name` é o que decide o código). */
const erroNomeado = (name: string) => Object.assign(new Error(name), { name });

describe("codigoDoErroGoogle (volta da conexão da Agenda Google)", () => {
  it("quem não está em GOOGLE_AGENDA_LIBERADOS volta com ?google=nao-liberada (A2)", () => {
    expect(codigoDoErroGoogle(erroNomeado("AgendaGoogleNaoLiberada"))).toBe("nao-liberada");
  });

  it("os outros erros seguem com o código de sempre", () => {
    expect(codigoDoErroGoogle(erroNomeado("ForbiddenError"))).toBe("sem-permissao");
    expect(codigoDoErroGoogle(erroNomeado("AgendaGoogleDeOutraPessoa"))).toBe("outra-pessoa");
    expect(codigoDoErroGoogle(erroNomeado("EstadoOAuthInvalido"))).toBe("expirou");
    expect(codigoDoErroGoogle(new Error("qualquer coisa"))).toBe("falhou");
  });

  it("os erros do envio pelo Gmail (E7) viram códigos que a aba E-mail entende", () => {
    expect(codigoDoErroGoogle(erroNomeado("AgendaGoogleNecessaria"))).toBe("agenda-antes");
    expect(codigoDoErroGoogle(erroNomeado("PermissaoDoGmailNegada"))).toBe("sem-gmail");
    expect(codigoDoErroGoogle(erroNomeado("CaixaJaConectadaComSenha"))).toBe("caixa-com-senha");
    expect(codigoDoErroGoogle(erroNomeado("GmailEmOutraConta"))).toBe("gmail-outra-conta");
    expect(codigoDoErroGoogle(erroNomeado("EnvioPeloGmailDesligado"))).toBe("gmail-desligado");
  });
});

describe("cookie da ida ao Google (a tela de volta)", () => {
  it("guarda e lê as três voltas, inclusive canais", () => {
    for (const volta of ["integracoes", "agenda", "canais"] as const) {
      const cookie = valorCookieGoogleAgenda({ nonce: "n", verificador: "v", volta });
      expect(lerCookieGoogleAgenda(cookie)).toEqual({ nonce: "n", verificador: "v", volta });
    }
  });

  it("volta desconhecida (ou cookie sem ela) cai em integracoes; lixo vira sem cookie", () => {
    expect(lerCookieGoogleAgenda(JSON.stringify({ n: "n", v: "v", r: "qualquer-coisa" }))?.volta).toBe("integracoes");
    expect(lerCookieGoogleAgenda(JSON.stringify({ n: "n", v: "v" }))?.volta).toBe("integracoes");
    expect(lerCookieGoogleAgenda("não é json")).toBeNull();
    expect(lerCookieGoogleAgenda(undefined)).toBeNull();
  });
});

describe("destinoDaVolta (para onde a pessoa volta e para onde o login a devolve)", () => {
  it("sem código: a tela de origem", () => {
    expect(destinoDaVolta("integracoes")).toBe("/integracoes");
    expect(destinoDaVolta("agenda")).toBe("/agenda");
    expect(destinoDaVolta("canais")).toBe("/integracoes/canais?canal=email");
  });

  it("com código: acrescenta google=<código> com ? ou &, conforme o caso", () => {
    expect(destinoDaVolta("integracoes", "conectado")).toBe("/integracoes?google=conectado");
    expect(destinoDaVolta("agenda", "falhou")).toBe("/agenda?google=falhou");
    expect(destinoDaVolta("canais", "gmail-conectado")).toBe("/integracoes/canais?canal=email&google=gmail-conectado");
  });

  it("nunca produz /canais (que não existe)", () => {
    for (const volta of ["integracoes", "agenda", "canais"] as const) {
      expect(destinoDaVolta(volta)).not.toBe("/canais");
      expect(destinoDaVolta(volta, "x")).not.toMatch(/^\/canais/);
    }
  });

  it("o código vai codificado (não deixa um & virar outro parâmetro)", () => {
    expect(destinoDaVolta("canais", "a&b=c")).toBe("/integracoes/canais?canal=email&google=a%26b%3Dc");
  });
});
