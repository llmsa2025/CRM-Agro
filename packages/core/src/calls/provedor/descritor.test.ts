import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contemSegredo, redigirSegredos } from "./comum";
import { descritorDeTeste } from "./apoio-de-teste";
import {
  formularioDoProvedorDeLigacao,
  problemasDoDescritorDeLigacao,
  segredosDasCredenciaisDeLigacao,
  validarCredenciaisDeLigacao,
  validarSegredoDoWebhookDeLigacao,
  visaoDasCredenciaisDeLigacao,
  type DescritorDeLigacao,
} from "./descritor";

const com = (troca: Partial<DescritorDeLigacao>) => descritorDeTeste("teste_um", troca);

describe("descritor de ligação: conferência do próprio descritor", () => {
  it("descritor coerente não tem problema", () => {
    expect(problemasDoDescritorDeLigacao(descritorDeTeste())).toEqual([]);
  });

  it("aponta cada problema, em português e sem valores", () => {
    const campo = descritorDeTeste().campos[0]!;
    const casos: [Partial<DescritorDeLigacao>, string][] = [
      [{ chave: "Chave Ruim" }, "A chave do provedor tem formato inválido."],
      [{ nome: "  " }, "O provedor precisa de um nome."],
      [{ ambientes: [] }, "Declare ao menos um ambiente."],
      [{ ambientes: ["producao", "producao"] }, "Ambientes repetidos."],
      [{ ambientes: ["homologacao" as never] }, "Ambiente desconhecido."],
      [{ webhook: { modo: "token" as never, instrucao: "x", eventosNecessarios: [] } }, "Modo de webhook desconhecido."],
      [{ webhook: { modo: "url_assinada", instrucao: " ", eventosNecessarios: [] } }, "Falta a instrução do webhook."],
      [{ testeDeConexao: "" }, "Descreva o que o teste de conexão faz."],
      [{ urlDaDocumentacao: "http://exemplo.invalid" }, "A documentação precisa de um endereço https."],
      [{ campos: [{ ...campo, chave: "1ruim" }] }, "Há campo com chave de formato inválido."],
      [{ campos: [campo, campo] }, "Há campos com a mesma chave."],
      [{ campos: [{ ...campo, rotulo: "" }] }, "Todo campo precisa de rótulo e ajuda."],
      [{ campos: [{ ...campo, ajuda: " " }] }, "Todo campo precisa de rótulo e ajuda."],
      [{ campos: [{ ...campo, escopo: "empresa" as never }] }, "Há campo com escopo desconhecido."],
      [{ campos: [{ ...campo, prefixoPorAmbiente: { teste: ["t_"] } }] }, "Prefixo declarado para um ambiente que o provedor não tem."],
    ];
    for (const [troca, esperado] of casos) expect(problemasDoDescritorDeLigacao(com(troca)), esperado).toContain(esperado);
  });

  it("os textos da tela seguem a §15 (sem travessão, meia-risca nem ' - ')", () => {
    const campo = descritorDeTeste().campos[0]!;
    const ruins: Partial<DescritorDeLigacao>[] = [
      { nome: "Telefonia — API" },
      { webhook: { modo: "url_assinada", instrucao: "Cadastre – depois teste.", eventosNecessarios: [] } },
      { testeDeConexao: "Lê a conta - sem criar nada." },
      { avisosDeSetup: ["Peça ao provedor — é rápido."] },
      { campos: [{ ...campo, ajuda: "Veja em Contas – Tokens." }] },
    ];
    for (const r of ruins) expect(problemasDoDescritorDeLigacao(com(r)).join(" ")).toMatch(/travessão/);
    // Hífen dentro de palavra é português correto.
    expect(problemasDoDescritorDeLigacao(com({ avisosDeSetup: ["Peça o ramal de pré-venda."] }))).toEqual([]);
  });
});

describe("descritor de ligação: validar o que o dono digitou, por escopo", () => {
  const conta = { dominio: "empresa", tokenDaConta: "token-da-conta-123456" };
  const linha = { ramal: "1001", senhaDoRamal: "senha-do-ramal-123" };

  it("valida o escopo da conta e o da linha separadamente", () => {
    expect(validarCredenciaisDeLigacao(descritorDeTeste(), "conta", conta, "producao")).toEqual({ ok: true, credenciais: conta });
    expect(validarCredenciaisDeLigacao(descritorDeTeste(), "linha", linha, "producao")).toEqual({ ok: true, credenciais: linha });
  });

  it("campo de outro escopo é recusado, sem repetir o nome que veio de fora", () => {
    const r = validarCredenciaisDeLigacao(descritorDeTeste(), "conta", { ...conta, ramal: "1001" }, "producao");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erros).toEqual([{ campo: "credenciais", mensagem: "O formulário tem um campo que este provedor não usa aqui." }]);
      expect(JSON.stringify(r.erros)).not.toContain("ramal");
    }
    expect(validarCredenciaisDeLigacao(descritorDeTeste(), "linha", { ...linha, campoInventado: "x" }, "producao").ok).toBe(false);
  });

  it("obrigatório vazio, formato errado e curto demais viram mensagem fixa, sem ecoar o valor", () => {
    const r = validarCredenciaisDeLigacao(descritorDeTeste(), "conta", { dominio: "  ", tokenDaConta: "curto" }, "producao");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erros).toEqual([
        { campo: "dominio", mensagem: "Preencha este campo." },
        { campo: "tokenDaConta", mensagem: "O valor é curto demais." },
      ]);
      expect(JSON.stringify(r.erros)).not.toContain("curto\"");
    }
    const formato = validarCredenciaisDeLigacao(descritorDeTeste(), "linha", { ...linha, ramal: "abc" }, "producao");
    expect(formato.ok).toBe(false);
    if (!formato.ok) expect(JSON.stringify(formato.erros)).not.toContain("abc");
  });

  it("campo opcional vazio é omitido", () => {
    const d = com({ campos: [{ chave: "apelido", rotulo: "Apelido", ajuda: "Nome para você reconhecer a conta.", escopo: "conta", obrigatorio: false, secreto: false, schema: z.string().max(20) }] });
    expect(validarCredenciaisDeLigacao(d, "conta", { apelido: "" }, "producao")).toEqual({ ok: true, credenciais: {} });
  });

  it("entrada que não é objeto e ambiente que o provedor não tem são recusados", () => {
    for (const entrada of [null, undefined, "texto", 7, [conta]]) expect(validarCredenciaisDeLigacao(descritorDeTeste(), "conta", entrada, "producao").ok).toBe(false);
    const r = validarCredenciaisDeLigacao(descritorDeTeste(), "conta", conta, "teste");
    expect(r).toEqual({ ok: false, erros: [{ campo: "ambiente", mensagem: "Este provedor não tem esse ambiente." }] });
  });

  it("prefixo por ambiente recusa chave de outro ambiente", () => {
    const base = descritorDeTeste();
    const d = com({
      ambientes: ["teste", "producao"],
      campos: base.campos.map((c) => (c.chave === "tokenDaConta" ? { ...c, prefixoPorAmbiente: { teste: ["t_"], producao: ["p_"] } } : c)),
    });
    const t = { ...conta, tokenDaConta: "t_token-da-conta-123456" };
    expect(validarCredenciaisDeLigacao(d, "conta", t, "teste").ok).toBe(true);
    const r = validarCredenciaisDeLigacao(d, "conta", t, "producao");
    expect(r).toEqual({ ok: false, erros: [{ campo: "tokenDaConta", mensagem: "A chave não parece ser do ambiente escolhido." }] });
  });

  it("segredo do webhook: valida quando o descritor tem e recusa quando não tem", () => {
    expect(validarSegredoDoWebhookDeLigacao(descritorDeTeste(), "x".repeat(20))).toEqual({ ok: true, valor: "x".repeat(20) });
    expect(validarSegredoDoWebhookDeLigacao(descritorDeTeste(), "curto").ok).toBe(false);
    expect(validarSegredoDoWebhookDeLigacao(descritorDeTeste(), "").ok).toBe(false);
    const sem = com({ segredoDoWebhook: null });
    expect(validarSegredoDoWebhookDeLigacao(sem, undefined)).toEqual({ ok: true, valor: null });
    expect(validarSegredoDoWebhookDeLigacao(sem, "algo").ok).toBe(false);
  });
});

describe("descritor de ligação: o que sobe para a tela", () => {
  const d = descritorDeTeste();

  it("segredo vira { preenchido, ultimos4 } e nunca o valor; campo comum mostra o valor", () => {
    const v = visaoDasCredenciaisDeLigacao(d, "conta", { dominio: "empresa", tokenDaConta: "token-da-conta-123456" });
    expect(v).toEqual([
      { chave: "dominio", escopo: "conta", secreto: false, preenchido: true, ultimos4: null, valor: "empresa" },
      { chave: "tokenDaConta", escopo: "conta", secreto: true, preenchido: true, ultimos4: "3456" },
    ]);
    expect(JSON.stringify(v)).not.toContain("token-da-conta");
  });

  it("a visão da linha só traz os campos da linha", () => {
    const v = visaoDasCredenciaisDeLigacao(d, "linha", { ramal: "1001", senhaDoRamal: "senha-do-ramal-123", dominio: "empresa" });
    expect(v.map((c) => c.chave)).toEqual(["ramal", "senhaDoRamal"]);
    expect(JSON.stringify(v)).not.toContain("senha-do-ramal");
  });

  it("segredo curto não mostra o final, e vazio diz que não está preenchido", () => {
    const curta = visaoDasCredenciaisDeLigacao(d, "linha", { ramal: "1001", senhaDoRamal: "abcdefgh" });
    expect(curta[1]).toEqual({ chave: "senhaDoRamal", escopo: "linha", secreto: true, preenchido: true, ultimos4: null });
    const vazia = visaoDasCredenciaisDeLigacao(d, "linha", {});
    expect(vazia).toEqual([
      { chave: "ramal", escopo: "linha", secreto: false, preenchido: false, ultimos4: null },
      { chave: "senhaDoRamal", escopo: "linha", secreto: true, preenchido: false, ultimos4: null },
    ]);
  });

  it("a lista de segredos tem os campos secretos e o segredo do webhook (atual e anterior), e alimenta a redação", () => {
    const credenciais = { dominio: "empresa", tokenDaConta: "token-da-conta-123456", ramal: "1001", senhaDoRamal: "senha-do-ramal-123" };
    const segredos = segredosDasCredenciaisDeLigacao(d, credenciais, { atual: "webhook-atual-123456", anterior: "webhook-antigo-123456" });
    expect(segredos.sort()).toEqual(["senha-do-ramal-123", "token-da-conta-123456", "webhook-antigo-123456", "webhook-atual-123456"].sort());
    expect(segredosDasCredenciaisDeLigacao(d, credenciais)).toHaveLength(2);

    const erro = new Error("falhou com token-da-conta-123456 e webhook-atual-123456");
    expect(contemSegredo(erro, segredos)).toBe(true);
    expect(redigirSegredos(erro.message, segredos)).toBe("falhou com [segredo] e [segredo]");
  });

  it("o formulário não leva schema nem valor, e serializa", () => {
    const f = formularioDoProvedorDeLigacao(d);
    expect(f.campos.map((c) => [c.chave, c.escopo, c.secreto])).toEqual([
      ["dominio", "conta", false],
      ["tokenDaConta", "conta", true],
      ["ramal", "linha", false],
      ["senhaDoRamal", "linha", true],
    ]);
    expect(f.campos.every((c) => !("schema" in c))).toBe(true);
    expect(f.segredoDoWebhook).toEqual({ rotulo: "Segredo do aviso", ajuda: "O CRM Agro gera este valor.", obrigatorio: true });
    expect(() => JSON.stringify(f)).not.toThrow();
    expect(formularioDoProvedorDeLigacao(com({ segredoDoWebhook: null })).segredoDoWebhook).toBeNull();
  });
});
