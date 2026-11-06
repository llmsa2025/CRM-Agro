import { describe, expect, it } from "vitest";
import {
  decidirPorEmail,
  dominioDoEmail,
  emailCasaDominio,
  emailDeContabilidade,
  emailValido,
  exigeEmail,
  palavrasDoDominio,
  type OpcoesDeEmail,
} from "./email-filtros";

/** Regras puras de e-mail da busca por filtro: contabilidade exclui a empresa; "só com e-mail"; palavra no domínio. */
const SEM: OpcoesDeEmail = { ignorarEmailContabilidade: false, soComEmail: false, emailDominio: [] };
const opc = (o: Partial<OpcoesDeEmail>): OpcoesDeEmail => ({ ...SEM, ...o });

describe("emailDeContabilidade", () => {
  it("'contab' em qualquer lugar, antes ou depois do @, sem diferença de maiúscula e de acento", () => {
    for (const e of ["contabilidade@x.com.br", "CONTABIL@x.com", "financeiro@contabilizei.com.br", "a@escritoriocontabil.com", "contábil@x.com"]) {
      expect(emailDeContabilidade(e), e).toBe(true);
    }
  });

  it("'cont' só como palavra inteira (início, fim ou . - _ @)", () => {
    for (const e of ["cont@empresa.com", "cont.sul@x.com.br", "a.cont@x.com", "a-cont@x.com", "a_cont_b@x.com", "empresa@cont.com.br", "x@sul.cont", "CONT@X.COM"]) {
      expect(emailDeContabilidade(e), e).toBe(true);
    }
  });

  it("'cont' como pedaço de outra palavra NÃO exclui (contato, contrato, controle, continental)", () => {
    for (const e of ["contato@empresa.com", "contrato@x.com", "controle@x.com", "continental@x.com", "x@contato.com.br", "vendas@continental.com.br", "econtato@x.com", "cont4@x.com"]) {
      expect(emailDeContabilidade(e), e).toBe(false);
    }
  });

  it("vazio e nulo não são contabilidade", () => {
    expect(emailDeContabilidade(null)).toBe(false);
    expect(emailDeContabilidade("")).toBe(false);
  });
});

describe("palavras do domínio", () => {
  it("tira o @ digitado, a caixa e o acento; vírgula separa (OU); sem repetir", () => {
    expect(palavrasDoDominio("@Grupo, AGRÍCOLA ; grupo")).toEqual(["grupo", "agricola"]);
    expect(palavrasDoDominio("   ")).toEqual([]);
    expect(palavrasDoDominio("@")).toEqual([]);
    expect(palavrasDoDominio(null)).toEqual([]);
  });

  it("casa no domínio (depois do @), não na parte local; 'contém', não exige começar", () => {
    expect(dominioDoEmail("contato@GrupoABC.com.br")).toBe("grupoabc.com.br");
    expect(emailCasaDominio("contato@grupoabc.com.br", ["grupo"])).toBe(true);
    expect(emailCasaDominio("contato@meugrupo.com.br", ["grupo"])).toBe(true);
    expect(emailCasaDominio("grupo@gmail.com", ["grupo"])).toBe(false);
    expect(emailCasaDominio("grupo.vendas@empresa.com.br", ["grupo"])).toBe(false);
  });

  it("vários termos: basta um (OU) e sem acento", () => {
    expect(emailCasaDominio("a@agricola.com", ["grupo", "agricola"])).toBe(true);
    expect(emailCasaDominio("a@agrícola.com.br", ["agricola"])).toBe(true);
    expect(emailCasaDominio("a@outra.com", ["grupo", "agricola"])).toBe(false);
  });
});

describe("decidirPorEmail", () => {
  it("sem nenhuma opção: aprova com o e-mail que tem (ou sem e-mail)", () => {
    expect(decidirPorEmail("A@x.com", [], SEM)).toEqual({ aprovada: true, email: "a@x.com" });
    expect(decidirPorEmail(null, [], SEM)).toEqual({ aprovada: true, email: null });
  });

  it("contabilidade EXCLUI a empresa (não só o e-mail), antes ou depois do @", () => {
    const o = opc({ ignorarEmailContabilidade: true });
    expect(decidirPorEmail("contabilidade@x.com", [], o)).toMatchObject({ aprovada: false, motivo: "contabilidade" });
    expect(decidirPorEmail("a@escritoriocontabil.com", [], o)).toMatchObject({ aprovada: false, motivo: "contabilidade" });
    expect(decidirPorEmail("cont@x.com", [], o)).toMatchObject({ aprovada: false });
  });

  it("contato@ NÃO exclui; com a opção desligada, contabilidade passa", () => {
    expect(decidirPorEmail("contato@empresa.com", [], opc({ ignorarEmailContabilidade: true }))).toEqual({ aprovada: true, email: "contato@empresa.com" });
    expect(decidirPorEmail("contabil@x.com", [], SEM)).toMatchObject({ aprovada: true });
  });

  it("empresa com mais de um e-mail: sai se ALGUM for de contabilidade", () => {
    const o = opc({ ignorarEmailContabilidade: true });
    expect(decidirPorEmail("vendas@empresa.com", ["contab@escritorio.com"], o)).toMatchObject({ aprovada: false, motivo: "contabilidade" });
    expect(decidirPorEmail("vendas@empresa.com", ["financeiro@empresa.com"], o)).toMatchObject({ aprovada: true });
  });

  it("'Só com e-mail': sem e-mail válido a empresa sai", () => {
    const o = opc({ soComEmail: true });
    expect(decidirPorEmail(null, [], o)).toMatchObject({ aprovada: false, motivo: "sem_email" });
    expect(decidirPorEmail("sem-arroba", [], o)).toMatchObject({ aprovada: false, motivo: "sem_email" });
    expect(decidirPorEmail("a@x.com", [], o)).toMatchObject({ aprovada: true, email: "a@x.com" });
  });

  it("e-mail só de contabilidade + 'Só com e-mail': a empresa sai (por contabilidade)", () => {
    const o = opc({ ignorarEmailContabilidade: true, soComEmail: true });
    expect(decidirPorEmail("contabil@x.com", [], o)).toMatchObject({ aprovada: false });
  });

  it("palavra no domínio: só entra quem tem a palavra depois do @; o e-mail que casou fica no cadastro", () => {
    const o = opc({ soComEmail: true, emailDominio: ["grupo"] });
    expect(decidirPorEmail("contato@grupoabc.com.br", [], o)).toEqual({ aprovada: true, email: "contato@grupoabc.com.br" });
    expect(decidirPorEmail("grupo@gmail.com", [], o)).toMatchObject({ aprovada: false, motivo: "dominio" });
    expect(decidirPorEmail("grupo@gmail.com", ["vendas@grupoxyz.com"], o)).toEqual({ aprovada: true, email: "vendas@grupoxyz.com" });
    expect(decidirPorEmail(null, [], o)).toMatchObject({ aprovada: false, motivo: "sem_email" });
  });

  it("palavra no domínio + contabilidade: a contabilidade tira primeiro", () => {
    const o = opc({ ignorarEmailContabilidade: true, soComEmail: true, emailDominio: ["grupo"] });
    expect(decidirPorEmail("a@grupocontabil.com.br", [], o)).toMatchObject({ aprovada: false, motivo: "contabilidade" });
  });

  it("exigeEmail: só com e-mail ou palavra no domínio", () => {
    expect(exigeEmail(SEM)).toBe(false);
    expect(exigeEmail(opc({ soComEmail: true }))).toBe(true);
    expect(exigeEmail(opc({ emailDominio: ["x"] }))).toBe(true);
  });

  it("emailValido", () => {
    expect(emailValido("a@b.com")).toBe(true);
    expect(emailValido("a@b")).toBe(false);
    expect(emailValido("a b@c.com")).toBe(false);
    expect(emailValido(null)).toBe(false);
  });
});
