import { describe, expect, it } from "vitest";
import { HREF_CONECTAR_GMAIL, mensagemDoErroDeDesligarGmail, opcoesDeConexaoDeEmail, resultadoDoGoogleEmCanais, rotuloDoProvedor } from "./gmail";

describe("resultadoDoGoogleEmCanais (o aviso da volta do Google)", () => {
  it("sem código não há aviso", () => {
    expect(resultadoDoGoogleEmCanais(null)).toBeNull();
    expect(resultadoDoGoogleEmCanais("")).toBeNull();
  });

  it("o sucesso do Gmail é o único aviso verde, com o texto da ficha", () => {
    expect(resultadoDoGoogleEmCanais("gmail-conectado")).toEqual({
      ok: true,
      texto: "Pronto. Os e-mails desta caixa agora saem pelo seu Gmail.",
    });
  });

  it("cada código do Gmail tem o seu texto, todos como erro", () => {
    expect(resultadoDoGoogleEmCanais("agenda-antes")).toMatchObject({ ok: false, texto: "Conecte primeiro a sua Agenda Google (Integrações, Minha Agenda Google)." });
    expect(resultadoDoGoogleEmCanais("sem-gmail")?.texto).toBe("O Google não liberou o envio. Conecte de novo e marque a permissão do Gmail.");
    expect(resultadoDoGoogleEmCanais("caixa-com-senha")?.texto).toContain("Esta caixa já está conectada com senha de app");
    expect(resultadoDoGoogleEmCanais("gmail-outra-conta")?.texto).toContain("Escolha a mesma conta Google da sua Agenda");
    expect(resultadoDoGoogleEmCanais("gmail-desligado")?.texto).toBe("O envio pelo Gmail ainda não está ligado neste servidor.");
    for (const c of ["agenda-antes", "sem-gmail", "caixa-com-senha", "gmail-outra-conta", "gmail-desligado"]) {
      expect(resultadoDoGoogleEmCanais(c)?.ok, c).toBe(false);
    }
  });

  it("os códigos da Agenda continuam valendo na aba E-mail", () => {
    for (const c of ["cancelado", "expirou", "sem-agenda", "outra-pessoa", "nao-liberada", "sem-permissao", "indisponivel", "configuracao", "falhou"]) {
      const r = resultadoDoGoogleEmCanais(c);
      expect(r, c).not.toBeNull();
      expect(r?.ok, c).toBe(false);
    }
  });

  it("código desconhecido (ou nome de propriedade do objeto) vira 'falhou', nunca o texto cru da URL", () => {
    const falhou = resultadoDoGoogleEmCanais("falhou");
    expect(resultadoDoGoogleEmCanais("<script>alert(1)</script>")).toEqual(falhou);
    expect(resultadoDoGoogleEmCanais("constructor")).toEqual(falhou);
    expect(resultadoDoGoogleEmCanais("__proto__")).toEqual(falhou);
  });

  it("nenhum texto usa travessão nem meia-risca (AGENTS.md (texto da interface))", () => {
    for (const c of ["gmail-conectado", "agenda-antes", "sem-gmail", "caixa-com-senha", "gmail-outra-conta", "gmail-desligado", "falhou"]) {
      expect(resultadoDoGoogleEmCanais(c)?.texto, c).not.toMatch(/[—–]/);
    }
  });
});

describe("rotuloDoProvedor", () => {
  it("a conta do Gmail sem senha tem nome próprio; o resto fica como é", () => {
    expect(rotuloDoProvedor("gmail_api")).toBe("Gmail (sem senha)");
    expect(rotuloDoProvedor("smtp")).toBe("smtp");
    expect(rotuloDoProvedor("gmail")).toBe("gmail");
    expect(rotuloDoProvedor("evolution")).toBe("evolution");
  });
});

describe("mensagemDoErroDeDesligarGmail (nunca a mensagem crua do core)", () => {
  it("OwnedNotFound e ForbiddenError: só o dono ou um administrador", () => {
    const texto = "Só o dono da caixa ou um administrador pode desligar o envio pelo Gmail.";
    expect(mensagemDoErroDeDesligarGmail("OwnedNotFound")).toBe(texto);
    expect(mensagemDoErroDeDesligarGmail("ForbiddenError")).toBe(texto);
  });

  it("qualquer outro erro", () => {
    expect(mensagemDoErroDeDesligarGmail("Error")).toBe("Não deu para desligar agora. Tente de novo em instantes.");
    expect(mensagemDoErroDeDesligarGmail("")).toBe("Não deu para desligar agora. Tente de novo em instantes.");
  });
});

describe("opcoesDeConexaoDeEmail (o pop-up 'Conectar e-mail': uma forma por endereço)", () => {
  const EU = "marcos@gmail.com";

  it("pode conectar sem senha: as duas formas ficam à escolha, sem aviso", () => {
    const o = opcoesDeConexaoDeEmail({ envioGmail: "pode-conectar", enderecoGoogle: EU, senhaNoEnderecoDoGoogle: false });
    expect(o.semSenha).toMatchObject({ titulo: "Sem senha (Gmail)", habilitada: true, aviso: null });
    expect(o.imap).toMatchObject({ titulo: "IMAP e SMTP (senha de app)", habilitada: true, aviso: null });
  });

  it("★ o endereço já está com senha de app: o sem senha fica bloqueado e o aviso manda apagar a caixa", () => {
    const o = opcoesDeConexaoDeEmail({ envioGmail: "pode-conectar", enderecoGoogle: EU, senhaNoEnderecoDoGoogle: true });
    expect(o.semSenha.habilitada).toBe(false);
    expect(o.semSenha.aviso).toBe(`${EU} já está conectado por IMAP e SMTP. Apague essa caixa para conectar sem senha.`);
    expect(o.imap.habilitada).toBe(true);
  });

  it("★ o endereço já está sem senha: o sem senha mostra 'já conectado' e o IMAP avisa que esse endereço não serve, mas segue à escolha", () => {
    const o = opcoesDeConexaoDeEmail({ envioGmail: "conectado", enderecoGoogle: EU, senhaNoEnderecoDoGoogle: false });
    expect(o.semSenha).toMatchObject({ habilitada: false, aviso: `Já conectado com ${EU}.` });
    expect(o.imap.habilitada).toBe(true);
    expect(o.imap.aviso).toContain(EU);
    expect(o.imap.aviso).toContain("Outros endereços podem");
  });

  it("sem a Agenda: bloqueia e leva para Integrações; desligado: bloqueia sem link", () => {
    const antes = opcoesDeConexaoDeEmail({ envioGmail: "agenda-antes", enderecoGoogle: null, senhaNoEnderecoDoGoogle: false });
    expect(antes.semSenha.habilitada).toBe(false);
    expect(antes.semSenha.avisoLink).toEqual({ texto: "Ir para Integrações", href: "/integracoes" });
    const desligado = opcoesDeConexaoDeEmail({ envioGmail: "desligado", enderecoGoogle: null, senhaNoEnderecoDoGoogle: false });
    expect(desligado.semSenha).toMatchObject({ habilitada: false, aviso: "Ainda não está disponível para a sua conta." });
    expect(desligado.semSenha.avisoLink).toBeUndefined();
    // Em nenhum estado o IMAP deixa de existir (quem não tem Google segue conectando por senha).
    expect(antes.imap.habilitada && desligado.imap.habilitada).toBe(true);
  });

  it("nunca há as duas formas escolhíveis para o mesmo endereço", () => {
    for (const envioGmail of ["desligado", "agenda-antes", "pode-conectar", "conectado"] as const) {
      for (const senha of [false, true]) {
        const o = opcoesDeConexaoDeEmail({ envioGmail, enderecoGoogle: EU, senhaNoEnderecoDoGoogle: senha });
        // Sem senha escolhível só quando não há senha no endereço e o Gmail ainda não está conectado.
        expect(o.semSenha.habilitada, `${envioGmail}/${senha}`).toBe(envioGmail === "pode-conectar" && !senha);
      }
    }
  });

  it("o botão do sem senha leva à rota que põe o cookie e manda para o Google", () => {
    expect(HREF_CONECTAR_GMAIL).toBe("/api/integracoes/google/conectar?volta=canais&recurso=gmail");
  });
});
