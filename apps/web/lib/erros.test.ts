import { afterEach, describe, expect, it, vi } from "vitest";
import { MENSAGEM_ERRO_GENERICA, mensagemDaRegra, mensagemParaTela } from "./erros";

afterEach(() => vi.restoreAllMocks());

describe("mensagemParaTela", () => {
  it("deixa passar a mensagem escrita para a pessoa", () => {
    expect(mensagemParaTela(new Error("Informe o nome do funil."))).toBe("Informe o nome do funil.");
    expect(mensagemParaTela("Esse telefone já está cadastrado.")).toBe("Esse telefone já está cadastrado.");
  });

  it("esconde o erro cru do Prisma, que traz o endereço do banco", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cru =
      "\nInvalid `prisma.contact.findMany()` invocation:\n\n\nCan't reach database server at `db.exemplo.supabase.co:6543`";
    expect(mensagemParaTela(new Error(cru))).toBe(MENSAGEM_ERRO_GENERICA);
    expect(log).toHaveBeenCalledOnce();
  });

  it("esconde pool esgotado, erro de rede, SQL e pilha de chamadas", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const texto of [
      "Timed out fetching a new connection from the connection pool. More info: http://pris.ly/d/connection-pool",
      "connect ECONNREFUSED 127.0.0.1:6381",
      "fetch failed",
      'column "x" of relation "Contact" does not exist',
      "Unique constraint failed (P2002)",
      "Erro\n    at foo (/srv/crmagro/app.js:10:5)",
      "Unexpected token < in JSON at position 0",
      "Cannot read properties of undefined (reading 'id')",
    ]) {
      expect(mensagemParaTela(new Error(texto)), texto).toBe(MENSAGEM_ERRO_GENERICA);
    }
  });

  it("valor que não é erro e texto vazio viram a frase genérica", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mensagemParaTela(undefined)).toBe(MENSAGEM_ERRO_GENERICA);
    expect(mensagemParaTela(new Error(""))).toBe(MENSAGEM_ERRO_GENERICA);
    expect(mensagemParaTela({ qualquer: "coisa" })).toBe(MENSAGEM_ERRO_GENERICA);
  });

  it("erro de regra conhecido continua legível, sem o prefixo com o nome", () => {
    const e = new Error("ContatoJaCadastrado: este contato já existe com o responsável João");
    e.name = "ContatoJaCadastrado";
    expect(mensagemDaRegra(e)).toBe("Este contato já existe com o responsável João");
    expect(mensagemParaTela(e)).toBe("Este contato já existe com o responsável João");
  });

  it("com semPrefixo tira o nome do erro da frente, e sem a opção mantém", () => {
    const e = new Error("EnvioAindaNaoConfirmado: o mesmo arquivo foi enviado há pouco");
    expect(mensagemParaTela(e, { semPrefixo: true })).toBe("o mesmo arquivo foi enviado há pouco");
    expect(mensagemParaTela(e)).toBe("EnvioAindaNaoConfirmado: o mesmo arquivo foi enviado há pouco");
  });

  it("não deixa o String(e) com 'Error: ' na frente chegar à tela", () => {
    expect(mensagemParaTela(new Error("Erro 500"))).toBe("Erro 500");
  });

  it("mensagem longa demais não vai para a tela", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mensagemParaTela(new Error("a".repeat(500)))).toBe(MENSAGEM_ERRO_GENERICA);
  });
});
