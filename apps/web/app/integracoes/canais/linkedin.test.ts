import { describe, expect, it } from "vitest";
import { HREF_CONECTAR_LINKEDIN, linhaDoLinkedin, mensagemDoErroDoLinkedin, RESULTADO_LINKEDIN, resultadoDoLinkedinEmCanais } from "./linkedin";
import { codigoDoErroLinkedin, destinoDaVoltaLinkedin, lerCookieLinkedin, valorCookieLinkedin } from "../../../lib/linkedin-oauth";

describe("resultado da volta do LinkedIn", () => {
  it("sem código não mostra nada; código conhecido tem texto; desconhecido vira 'falhou' (nunca o texto da URL)", () => {
    expect(resultadoDoLinkedinEmCanais(null)).toBeNull();
    expect(resultadoDoLinkedinEmCanais("conectado")).toEqual({ ok: true, texto: expect.stringContaining("LinkedIn está conectado") });
    expect(resultadoDoLinkedinEmCanais("<script>alert(1)</script>")).toBe(RESULTADO_LINKEDIN.falhou);
    expect(resultadoDoLinkedinEmCanais("constructor")).toBe(RESULTADO_LINKEDIN.falhou);
  });

  it("só o 'conectado' é sucesso, e nenhum texto usa travessão", () => {
    for (const [codigo, r] of Object.entries(RESULTADO_LINKEDIN)) {
      expect(r.ok).toBe(codigo === "conectado");
      expect(r.texto).not.toMatch(/[—–]/);
    }
  });

  it("cada código que a rota pode devolver tem texto próprio", () => {
    const codigos = ["indisponivel", "sem-permissao", "expirou", "sem-publicar", "outra-pessoa", "configuracao", "falhou", "cancelado", "conectado"];
    for (const c of codigos) expect(RESULTADO_LINKEDIN).toHaveProperty(c);
  });
});

describe("linha da conta do LinkedIn", () => {
  it("ok mostra quantos dias faltam; vence logo pede para conectar de novo; vencida é erro", () => {
    expect(linhaDoLinkedin({ estado: "ok", dias: 40 })).toEqual({ tone: "ok", texto: "Conectado. Vale por mais 40 dias.", reconectar: false });
    expect(linhaDoLinkedin({ estado: "vence_logo", dias: 5 })).toMatchObject({ tone: "attention", reconectar: true, texto: expect.stringContaining("vence em 5 dias") });
    expect(linhaDoLinkedin({ estado: "vence_logo", dias: 1 })!.texto).toContain("vence amanhã");
    expect(linhaDoLinkedin({ estado: "vence_logo", dias: 0 })!.texto).toContain("vence hoje");
    expect(linhaDoLinkedin({ estado: "vencida", dias: -3 })).toMatchObject({ tone: "error", reconectar: true });
    expect(linhaDoLinkedin({ estado: "desconhecida", dias: null })).toEqual({ tone: "ok", texto: "Conectado.", reconectar: false });
    expect(linhaDoLinkedin(null)).toBeNull();
  });

  it("os textos não têm travessão", () => {
    for (const v of [{ estado: "ok", dias: 9 }, { estado: "vence_logo", dias: 2 }, { estado: "vencida", dias: -1 }] as const) {
      expect(linhaDoLinkedin(v)!.texto).not.toMatch(/[—–]/);
    }
  });

  it("o erro de uma action nunca sobe cru", () => {
    expect(mensagemDoErroDoLinkedin("ForbiddenError")).toContain("dono da conta");
    expect(mensagemDoErroDoLinkedin("PrismaClientKnownRequestError")).toBe("Não deu para concluir agora. Tente de novo em instantes.");
  });

  it("o botão de conectar leva à rota do servidor, voltando para Canais", () => {
    expect(HREF_CONECTAR_LINKEDIN).toBe("/api/integracoes/linkedin/conectar?volta=canais");
  });
});

describe("apoio das rotas do OAuth", () => {
  it("o destino da volta acrescenta o resultado à tela certa", () => {
    expect(destinoDaVoltaLinkedin("canais")).toBe("/integracoes/canais?canal=linkedin");
    expect(destinoDaVoltaLinkedin("canais", "conectado")).toBe("/integracoes/canais?canal=linkedin&linkedin=conectado");
    expect(destinoDaVoltaLinkedin("integracoes", "expirou")).toBe("/integracoes?linkedin=expirou");
    // O código nunca quebra a URL.
    expect(destinoDaVoltaLinkedin("canais", "a&b=c")).toBe("/integracoes/canais?canal=linkedin&linkedin=a%26b%3Dc");
  });

  it("o cookie da ida guarda o nonce e a volta; lixo vira 'sem cookie'", () => {
    expect(lerCookieLinkedin(valorCookieLinkedin({ nonce: "abc", volta: "integracoes" }))).toEqual({ nonce: "abc", volta: "integracoes" });
    expect(lerCookieLinkedin(valorCookieLinkedin({ nonce: "abc", volta: "canais" }))).toEqual({ nonce: "abc", volta: "canais" });
    expect(lerCookieLinkedin(undefined)).toBeNull();
    expect(lerCookieLinkedin("não é json")).toBeNull();
    expect(lerCookieLinkedin(JSON.stringify({ n: 1 }))).toBeNull();
    expect(lerCookieLinkedin(JSON.stringify({ n: "x".repeat(500) }))).toBeNull();
    // Volta desconhecida cai em Canais.
    expect(lerCookieLinkedin(JSON.stringify({ n: "abc", r: "agenda" }))).toEqual({ nonce: "abc", volta: "canais" });
  });

  it("o código do erro vem só do nome do erro (e do motivo de chave errada)", () => {
    const erro = (name: string, extra: object = {}) => Object.assign(new Error("msg com segredo"), { name, ...extra });
    expect(codigoDoErroLinkedin(erro("LinkedinIndisponivel"))).toBe("indisponivel");
    expect(codigoDoErroLinkedin(erro("ForbiddenError"))).toBe("sem-permissao");
    expect(codigoDoErroLinkedin(erro("EstadoLinkedinInvalido"))).toBe("expirou");
    expect(codigoDoErroLinkedin(erro("PermissaoDePublicarNegada"))).toBe("sem-publicar");
    expect(codigoDoErroLinkedin(erro("LinkedinDeOutraPessoa"))).toBe("outra-pessoa");
    expect(codigoDoErroLinkedin(erro("LinkedinApiErro", { status: 401, motivo: "invalid_client" }))).toBe("configuracao");
    expect(codigoDoErroLinkedin(erro("LinkedinApiErro", { status: 500, motivo: null }))).toBe("falhou");
    expect(codigoDoErroLinkedin("lixo")).toBe("falhou");
  });
});
