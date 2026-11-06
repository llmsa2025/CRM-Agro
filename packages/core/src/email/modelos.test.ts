import { describe, it, expect } from "vitest";
import {
  escaparHtml,
  modeloAlertaSaude,
  modeloAvisoCadastroExistente,
  modeloConfirmarCadastro,
  modeloConvite,
  modeloRedefinirSenha,
  modeloTesteDeEnvio,
  nomeSeguro,
} from "./modelos";

/**
 * Modelos dos e-mails da plataforma: link certo (no botão, por extenso e no
 * texto puro), HTML escapado no que vem de pessoa, rodapé e nenhuma imagem
 * externa. Puro: sem banco, sem envio.
 */

const LINK_RESET = "https://app.crmagro.example/redefinir-senha?token=prt_abc%2Bdef";
const LINK_CONVITE = "https://app.crmagro.example/criar-conta?token=inv_xyz";

/** `href`s do HTML (já com as entidades desfeitas). */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

describe("modelo — redefinir senha", () => {
  const m = modeloRedefinirSenha({ nome: "Marcos", email: "marcos@exemplo.com.br", link: LINK_RESET, validadeMin: 45 });

  it("leva o link certo no botão, por extenso e no texto puro", () => {
    expect(m.subject).toBe("Redefinição de senha no CRM Agro");
    expect(hrefs(m.html)).toEqual([LINK_RESET, LINK_RESET]);
    expect(m.text).toContain(LINK_RESET);
    expect(m.text).toContain("45 minutos");
    expect(m.html).toContain("Criar nova senha");
  });

  it("tem o rodapé: por que recebeu e 'não responda'", () => {
    expect(m.html).toContain("Você recebeu este e-mail porque alguém pediu para redefinir a senha da conta marcos@exemplo.com.br");
    expect(m.html).toContain("Não responda: este endereço não recebe mensagens.");
    expect(m.text).toContain("Você recebeu este e-mail porque");
    expect(m.text).toContain("Não responda: este endereço não recebe mensagens.");
  });

  it("escapa HTML no nome (nome vem da pessoa)", () => {
    const x = modeloRedefinirSenha({
      nome: `<script>alert("x")</script><a href="https://mal.example">clique</a>`,
      email: "a@b.com",
      link: LINK_RESET,
      validadeMin: 45,
    });
    expect(x.html).not.toContain("<script>");
    expect(x.html).not.toContain("mal.example\">");
    expect(x.html).toContain("&lt;script&gt;");
    // Único link do e-mail continua sendo o do reset.
    expect(hrefs(x.html)).toEqual([LINK_RESET, LINK_RESET]);
  });

  it("marca e HTML compatíveis: sem imagem, sem <style>, com as cores da marca", () => {
    expect(m.html).not.toMatch(/<img\b/i);
    expect(m.html).not.toMatch(/<style\b/i);
    expect(m.html).not.toMatch(/<svg\b/i);
    expect(m.html).toContain("#1F4A3A");
    expect(m.html).toContain("#D4A13A");
    expect(m.html).toContain('lang="pt-BR"');
  });

  it("com reply-to configurado, o rodapé convida a responder; pela caixa do time (legado), não fala de resposta", () => {
    const r = modeloRedefinirSenha({ email: "a@b.com", link: LINK_RESET, validadeMin: 45, resposta: "responda" });
    expect(r.html).not.toContain("Não responda");
    expect(r.text).toContain("Responda este e-mail");
    const legado = modeloRedefinirSenha({ email: "a@b.com", link: LINK_RESET, validadeMin: 45, resposta: "omitir" });
    expect(legado.html).not.toMatch(/Não responda|Responda este e-mail/);
    expect(legado.text).not.toMatch(/Não responda|Responda este e-mail/);
    expect(legado.html).toContain("Você recebeu este e-mail porque");
  });

  it("recusa link que não é http(s)", () => {
    expect(() => modeloRedefinirSenha({ email: "a@b.com", link: "javascript:alert(1)", validadeMin: 45 })).toThrow(/http/);
  });
});

describe("modelo — convite", () => {
  it("leva o link certo e diz quem convidou e para qual equipe", () => {
    const m = modeloConvite({ email: "novo@exemplo.com.br", link: LINK_CONVITE, validadeDias: 7, nomeDoTime: "Agro Norte", quemConvidou: "Maria" });
    expect(m.subject).toBe("Convite para a equipe Agro Norte no CRM Agro");
    expect(hrefs(m.html)).toEqual([LINK_CONVITE, LINK_CONVITE]);
    expect(m.text).toContain(LINK_CONVITE);
    expect(m.text).toContain("Maria convidou você para a equipe Agro Norte no CRM Agro.");
    expect(m.html).toContain("<strong>Maria</strong>");
    expect(m.html).toContain("7 dias");
    expect(m.html).toContain("Você recebeu este e-mail porque Maria convidou novo@exemplo.com.br");
    expect(m.html).toContain("Não responda: este endereço não recebe mensagens.");
  });

  it("escapa HTML no nome do time e de quem convidou; corta nome gigante e tira quebra de linha do assunto", () => {
    const m = modeloConvite({
      email: "novo@exemplo.com.br",
      link: LINK_CONVITE,
      validadeDias: 7,
      nomeDoTime: `Time <img src=x onerror=alert(1)>\r\nBcc: vitima@x.com`,
      quemConvidou: `"><script>roubar()</script>`,
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(m.html).toContain("&quot;&gt;&lt;script&gt;");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(nomeSeguro("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("sem nome do time nem de quem convidou, fica genérico", () => {
    const m = modeloConvite({ email: "novo@exemplo.com.br", link: LINK_CONVITE, validadeDias: 7 });
    expect(m.subject).toBe("Você foi convidado para o CRM Agro");
    expect(m.text).toContain("Uma pessoa da equipe convidou você para o CRM Agro.");
  });

  it("o e-mail digitado entra no rodapé sem quebra de linha e com tamanho máximo", () => {
    const phishing = `a@b.com\r\n\r\nSua conta será bloqueada. Confirme em https://evil.example/entrar ${"x".repeat(400)}`;
    const m = modeloConvite({ email: phishing, link: LINK_CONVITE, validadeDias: 7 });
    const rodape = m.text.split("\n").find((l) => l.startsWith("Você recebeu este e-mail porque"))!;
    expect(rodape).toContain("a@b.com Sua conta será bloqueada.");
    expect(rodape.length).toBeLessThan(254 + 200);
    expect(m.text).not.toContain("\r");
  });
});

describe("modelo — alerta de saúde e teste de envio", () => {
  it("lista os motivos (escapados) e o link da saúde", () => {
    const m = modeloAlertaSaude({
      status: "degraded",
      quando: "2026-09-28T12:00:00.000Z",
      motivos: ["motor: fila flow atrasada 12 min", "evolution: <timeout>"],
      linkDaSaude: "https://app.crmagro.example/api/health",
    });
    expect(m.subject).toBe("[CRM Agro] degraded: motor: fila flow atrasada 12 min");
    expect(m.html).toContain("evolution: &lt;timeout&gt;");
    expect(m.text).toContain("- evolution: <timeout>");
    expect(hrefs(m.html)).toEqual(["https://app.crmagro.example/api/health"]);
    expect(m.html).toContain("lista de alertas da operação");
  });

  it("e-mail de teste do remetente", () => {
    const m = modeloTesteDeEnvio({ quando: "28/09/2026 12:00", linkDoApp: "https://app.crmagro.example" });
    expect(m.subject).toContain("Teste do remetente");
    expect(hrefs(m.html)).toEqual(["https://app.crmagro.example"]);
    expect(m.text).toContain("Não responda");
  });

  it("escaparHtml cobre os cinco caracteres", () => {
    expect(escaparHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("modelo — confirmar o e-mail do cadastro", () => {
  const LINK = "https://app.crmagro.example/confirmar-email?token=cfe_abc%2Bdef";
  const m = modeloConfirmarCadastro({ email: "maria@fazenda.com.br", link: LINK, validadeHoras: 2 });

  it("leva o link no botão, por extenso e no texto puro; diz a validade e que pede a senha", () => {
    expect(m.subject).toBe("Confirme o seu e-mail no CRM Agro");
    expect(hrefs(m.html)).toEqual([LINK, LINK]);
    expect(m.text).toContain(LINK);
    expect(m.text).toContain("2 horas");
    expect(m.text).toContain("digite a senha que você escolheu");
    expect(m.text).toContain("Confirme o seu e-mail para criar a conta da sua empresa no CRM Agro.");
    expect(m.html).toContain("Confirmar e-mail");
  });

  it("diz o que fazer se não foi você e por que recebeu", () => {
    expect(m.text).toContain("Se não foi você que pediu, ignore este e-mail: sem a confirmação, nenhuma conta é criada.");
    expect(m.html).toContain("alguém usou maria@fazenda.com.br para criar a conta de uma empresa no CRM Agro");
    expect(m.html).toContain("Não responda");
  });

  it("texto fixo: nada do formulário anônimo (nome, empresa) entra no e-mail (não vira canal de phishing)", () => {
    // O tipo nem aceita nome/empresa; mesmo se alguém passar, nada disso aparece.
    const x = modeloConfirmarCadastro({
      email: "a@b.com",
      link: LINK,
      validadeHoras: 1,
      ...({ nome: "Suporte CRM Agro", empresa: "Pix bloqueado: libere em crmagro-pagto.example" } as object),
    });
    for (const parte of [x.subject, x.text, x.html]) {
      expect(parte).not.toContain("Pix bloqueado");
      expect(parte).not.toContain("crmagro-pagto.example");
      expect(parte).not.toContain("Suporte CRM Agro");
    }
    expect(hrefs(x.html)).toEqual([LINK, LINK]);
    expect(x.text).toContain("1 hora");
  });

  it("recusa link que não é http(s)", () => {
    expect(() => modeloConfirmarCadastro({ email: "a@b.com", link: "javascript:alert(1)", validadeHoras: 2 })).toThrow();
  });
});

describe("modelo — aviso de cadastro com e-mail que já tem conta", () => {
  const m = modeloAvisoCadastroExistente({
    nome: "Dona Antiga",
    email: "dona@fazenda.com.br",
    linkEntrar: "https://app.crmagro.example/login",
    linkEsqueci: "https://app.crmagro.example/esqueci-senha",
  });

  it("avisa que nada mudou e leva só aos links de entrar e de redefinir a senha", () => {
    expect(m.subject).toBe("Tentativa de criar conta no CRM Agro com o seu e-mail");
    expect(m.text).toContain("nada foi criado e nada mudou nela");
    expect(hrefs(m.html)).toEqual(["https://app.crmagro.example/login", "https://app.crmagro.example/esqueci-senha"]);
    expect(m.text).not.toContain("confirmar-email");
    expect(m.html).toContain("Olá, Dona Antiga.");
    expect(m.html).not.toMatch(/<img\b/i);
  });
});
