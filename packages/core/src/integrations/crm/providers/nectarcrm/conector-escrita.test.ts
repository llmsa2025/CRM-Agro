/**
 * N3: busca e escrita do conector contra o Nectar FALSO. Sem banco. O `fetch`
 * real é proibido no arquivo inteiro.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { criarNectarFalso, TOKEN_FALSO_NECTAR } from "../../../../test-support/nectar-falso";
import type { ConexaoAberta, ContatoLocal } from "../../contract";
import {
  CrmDadoInvalido,
  CrmIndisponivel,
  CrmNaoEncontrado,
  CrmRequisitoFaltando,
  CrmResultadoIncerto,
} from "../../errors";
import { criarClienteNectar, segmento } from "./client";
import { criarConectorNectar } from "./index";
import { atualizacaoDeContato, montarNota } from "./mapper";

const fetchOriginal = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("fetch real proibido");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = fetchOriginal;
});

const conexao: ConexaoAberta = { integrationId: "integracao-teste", token: TOKEN_FALSO_NECTAR };

async function erroDe(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("era para lançar erro");
}

const localMinimo = (p: Partial<ContatoLocal> = {}): ContatoLocal => ({
  id: "contato-1",
  nome: "Maria",
  sobrenome: null,
  emails: [],
  telefonesE164: [],
  linkedin: null,
  cpf: null,
  cargo: null,
  cidade: null,
  estado: null,
  endereco: null,
  origem: null,
  faturamentoAnual: null,
  relacionamentoStatus: "novo",
  tagNomes: [],
  ...p,
});

const OPTS_UPDATE = { criadoPeloCrmAgro: false, manterAtualizados: [] as never[], cpfLigado: false, formatoPreferido: "parenteses_hifen" as const };

describe("N3: busca de contato", () => {
  it("telefone: o número vai codificado no endereço (+ vira %2B); 404 vira lista vazia", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    expect(await conector.findContact(conexao, { telefone: "+5562999998888" })).toEqual([]);
    expect(falso.pedidos[0]!.url).toContain("/contatos/telefone/%2B5562999998888");
    falso.adicionarContato({ nome: "Maria", constante: 3, telefones: ["(62) 99999-8888"] });
    const achou = await conector.findContact(conexao, { telefone: "(62) 99999-8888" });
    expect(achou).toHaveLength(1);
    expect(falso.pedidos[1]!.url).toContain("/contatos/telefone/%2862%29%2099999-8888");
  });

  it("e-mail (sem diferença de maiúscula), CPF e CNPJ", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    falso.adicionarContato({ nome: "Ana", constante: 3, emails: ["Ana@X.com"], cpf: "12345678909", cnpj: "12.345.678/0001-90" });
    expect((await conector.findContact(conexao, { email: "ana@x.com" }))[0]?.nome).toBe("Ana");
    expect(falso.pedidos[0]!.url).toContain("/contatos/email/ana%40x.com");
    expect(await conector.findContact(conexao, { cpf: "12345678909" })).toHaveLength(1);
    expect(await conector.findContact(conexao, { cnpj: "12.345.678/0001-90" })).toHaveLength(1);
    expect(falso.pedidos[2]!.url).toContain("/contatos/cnpj/12.345.678%2F0001-90");
    expect(await conector.findContact(conexao, { cnpj: "12345678000190" })).toEqual([]);
  });

  it("código do CRM Agro: GET /contatos/?nome=<codigo>&exato=true", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    falso.adicionarContato({ nome: "Bia", constante: 3, codigo: "id-do-crmagro-1" });
    const r = await conector.findContact(conexao, { codigo: "id-do-crmagro-1" });
    expect(r).toHaveLength(1);
    const url = new URL(falso.pedidos[0]!.url);
    expect(url.searchParams.get("nome")).toBe("id-do-crmagro-1");
    expect(url.searchParams.get("exato")).toBe("true");
    expect(await conector.findContact(conexao, { codigo: "outro" })).toEqual([]);
  });

  it("nunca busca com * nem sem identificador", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    expect(await erroDe(() => conector.findContact(conexao, { email: "*@x.com" }))).toBeInstanceOf(CrmRequisitoFaltando);
    expect(await erroDe(() => conector.findContact(conexao, { telefone: "*" }))).toBeInstanceOf(CrmRequisitoFaltando);
    expect(await erroDe(() => conector.findContact(conexao, {}))).toBeInstanceOf(CrmRequisitoFaltando);
    expect(falso.pedidos).toHaveLength(0);
  });

  it("resposta em objeto vira lista; getContact e createContact devolvem o id como string", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const ref = await conector.createContact(conexao, { nome: "Caio", constante: 3, ativo: true, codigo: "c-1", emails: ["caio@x.com"] });
    expect(typeof ref.id).toBe("string");
    const remoto = await conector.getContact(conexao, ref.id);
    expect(remoto).toMatchObject({ id: ref.id, nome: "Caio", emails: ["caio@x.com"], codigo: "c-1", constante: 3, blocked: false, telefones: [], listas: [] });
  });

  it("getContact de contato que não existe: CrmNaoEncontrado", async () => {
    const conector = criarConectorNectar({ transporte: criarNectarFalso().transporte });
    expect(await erroDe(() => conector.getContact(conexao, "999"))).toBeInstanceOf(CrmNaoEncontrado);
  });
});

describe("N3: atualizar sem apagar", () => {
  it("getContact, atualizacaoDeContato e updateContact com PUT que substitui a lista: o e-mail do vendedor continua lá", async () => {
    const falso = criarNectarFalso({ putSubstituiListas: true });
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const id = String(falso.adicionarContato({ nome: "Maria", constante: 3, emails: ["a@x.com"] }));
    // O vendedor acrescenta um e-mail direto no Nectar.
    falso.dados.contatos[0]!.emails = ["a@x.com", "vendedor@x.com"];

    const remoto = await conector.getContact(conexao, id);
    const mudanca = atualizacaoDeContato(remoto, localMinimo({ emails: ["A@x.com", "novo@x.com"] }), OPTS_UPDATE);
    expect(mudanca).toEqual({ emails: ["a@x.com", "vendedor@x.com", "novo@x.com"] });
    await conector.updateContact(conexao, id, mudanca!);
    expect(falso.dados.contatos[0]!.emails).toEqual(["a@x.com", "vendedor@x.com", "novo@x.com"]);
    // Só a chave enviada mudou: o resto do contato ficou como estava.
    expect(falso.dados.contatos[0]).toMatchObject({ nome: "Maria", constante: 3 });
    expect(falso.pedidos.at(-1)!.metodo).toBe("PUT");
  });

  it("prova do risco: um PUT só com o e-mail novo (sem ler e unir antes) apagaria o que estava lá", async () => {
    const falso = criarNectarFalso({ putSubstituiListas: true });
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const id = String(falso.adicionarContato({ nome: "Maria", constante: 3, emails: ["a@x.com", "vendedor@x.com"] }));
    await conector.updateContact(conexao, id, { emails: ["novo@x.com"] });
    expect(falso.dados.contatos[0]!.emails).toEqual(["novo@x.com"]);
  });

  it("PUT sem uma chave preserva o valor (só a ausência da chave preserva)", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const id = String(falso.adicionarContato({ nome: "Maria", constante: 3, cargo: "Dona", codigo: "cod-1" }));
    await conector.updateContact(conexao, id, { origem: "Instagram" });
    expect(falso.dados.contatos[0]).toMatchObject({ cargo: "Dona", codigo: "cod-1", origem: "Instagram" });
  });
});

describe("N3: oportunidade, qualificação e notas", () => {
  it("oportunidade: cria, procura pelo contato (cliente ou contato) e atualiza", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const pessoa = await conector.createContact(conexao, { nome: "Maria", constante: 3 });
    const empresa = await conector.createContact(conexao, { nome: "Fazenda X", constante: 3, empresa: true });
    expect(await conector.findOpportunity(conexao, pessoa.id)).toEqual([]);
    const op = await conector.createOpportunity(conexao, { nome: "Maria (Fazenda X)", cliente: { id: empresa.id }, contato: { id: pessoa.id }, funilVenda: { id: "1" }, etapa: 1, valorAvulso: 100 });
    expect(typeof op.id).toBe("string");
    const daPessoa = await conector.findOpportunity(conexao, pessoa.id);
    expect(daPessoa).toEqual([{ id: op.id, nome: "Maria (Fazenda X)", status: 1, funilId: "1" }]);
    expect(await conector.findOpportunity(conexao, empresa.id)).toHaveLength(1);
    await conector.updateOpportunity(conexao, op.id, { valorAvulso: 250 });
    expect(falso.dados.oportunidades[0]!.valorAvulso).toBe(250);
  });

  it("qualificação: cria para Lead e procura pelo contato", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const pessoa = await conector.createContact(conexao, { nome: "Maria", constante: 3 });
    const q = await conector.createQualification(conexao, { nome: "Maria", cliente: { id: pessoa.id }, funilVenda: { id: "7" }, etapa: 1, status: 1 });
    expect(await conector.findQualification(conexao, pessoa.id)).toEqual([{ id: q.id, status: 1, funilId: "7" }]);
  });

  it("qualificação para contato Cliente, Prospect ou Descartado: CrmDadoInvalido (o falso recusa como a tela do Nectar)", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    for (const constante of [0, 1, 5] as const) {
      const pessoa = await conector.createContact(conexao, { nome: `Pessoa ${constante}`, constante });
      const e = await erroDe(() => conector.createQualification(conexao, { nome: "x", cliente: { id: pessoa.id }, funilVenda: { id: "7" }, etapa: 1, status: 1 }));
      expect(e).toBeInstanceOf(CrmDadoInvalido);
      // A mensagem não leva o texto da resposta do Nectar.
      expect(e.message).not.toContain("Lead e Suspect");
    }
    expect(falso.dados.qualificacoes).toHaveLength(0);
    // Com a recusa desligada, passa.
    falso.configurar({ recusarQualificacaoConstantes: [] });
    const pessoa = await conector.createContact(conexao, { nome: "Cliente", constante: 0 });
    await conector.createQualification(conexao, { nome: "x", cliente: { id: pessoa.id }, funilVenda: { id: "7" }, etapa: 1, status: 1 });
    expect(falso.dados.qualificacoes).toHaveLength(1);
  });

  it("contato bloqueado não recebe oportunidade nova", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const pessoa = await conector.createContact(conexao, { nome: "Maria", constante: 3 });
    falso.bloquearContato(pessoa.id);
    expect((await conector.getContact(conexao, pessoa.id)).blocked).toBe(true);
    const e = await erroDe(() => conector.createOpportunity(conexao, { nome: "x", cliente: { id: pessoa.id }, funilVenda: { id: "1" }, etapa: 1 }));
    expect(e).toBeInstanceOf(CrmDadoInvalido);
  });

  it("nota presa ao contato e à oportunidade; comentário na nota; comentário em nota inexistente dá CrmNaoEncontrado", async () => {
    const falso = criarNectarFalso();
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const pessoa = await conector.createContact(conexao, { nome: "Maria", constante: 3 });
    const op = await conector.createOpportunity(conexao, { nome: "x", cliente: { id: pessoa.id }, funilVenda: { id: "1" }, etapa: 1 });
    const nota = await conector.appendTimelineEntry(conexao, { assunto: "CRM Agro · Nota", descricaoHtml: "oi", contatoId: pessoa.id, oportunidadeId: op.id });
    expect(falso.dados.publicacoes[0]).toMatchObject({ assunto: "CRM Agro · Nota", descricao: "oi", contato: { id: pessoa.id }, oportunidade: { id: op.id } });
    expect(falso.dados.publicacoes[0]).not.toHaveProperty("qualificacao");
    await conector.appendTimelineComment(conexao, nota.id, "transcrição chegou depois");
    expect(falso.dados.comentarios[0]).toMatchObject({ publicacaoId: Number(nota.id), descricao: "transcrição chegou depois" });
    expect(await erroDe(() => conector.appendTimelineComment(conexao, "999", "x"))).toBeInstanceOf(CrmNaoEncontrado);
  });

  it("o CRM Agro nunca apaga nada no Nectar: o conector não tem método de exclusão nem o transporte usa DELETE", async () => {
    const conector = criarConectorNectar({ transporte: criarNectarFalso().transporte });
    expect(Object.keys(conector).filter((k) => /delete|remove|remov|apag|destroy/i.test(k))).toEqual([]);
  });
});

describe("N3: procura do marcador (conclusiva ou não)", () => {
  const DESDE_LONGE = new Date("2020-01-01T00:00:00Z");

  async function contatoENotas(falso: ReturnType<typeof criarNectarFalso>) {
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const pessoa = await conector.createContact(conexao, { nome: "Maria", constante: 3 });
    const nota = async (marcador: string) => {
      const { assunto, partes } = montarNota({ assunto: "CRM Agro · Nota", aconteceuEm: new Date(), autorNome: "Maria", linhas: ["oi"], marcador });
      return conector.appendTimelineEntry(conexao, { assunto, descricaoHtml: partes[0]!, contatoId: pessoa.id });
    };
    return { conector, pessoa, nota };
  }

  it("acha na 2ª página (conclusiva) e diz quantas páginas leu", async () => {
    const falso = criarNectarFalso({ tamanhoPagina: 50 });
    const { conector, nota } = await contatoENotas(falso);
    const alvo = await nota("alvo-1");
    falso.notasDeOutros(60);
    const r = await conector.findTimelineMarker(conexao, "alvo-1", DESDE_LONGE, 5);
    expect(r).toEqual({ achou: { id: alvo.id }, conclusiva: true, paginasLidas: 2 });
    expect(falso.pedidos.filter((p) => p.url.includes("/publicacao/?page=")).map((p) => new URL(p.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("para numa nota mais antiga que o início da operação: conclusiva, não achou", async () => {
    const falso = criarNectarFalso({ agora: () => new Date("2026-01-01T00:00:00Z") });
    const { conector, nota } = await contatoENotas(falso);
    await nota("velha-1");
    falso.notasDeOutros(3);
    const r = await conector.findTimelineMarker(conexao, "nao-existe", new Date("2026-06-01T00:00:00Z"), 5);
    expect(r).toEqual({ achou: null, conclusiva: true, paginasLidas: 1 });
  });

  it("bate no teto de páginas antes do ponto de parada: inconclusiva", async () => {
    const falso = criarNectarFalso({ tamanhoPagina: 50 });
    const { conector } = await contatoENotas(falso);
    falso.notasDeOutros(120);
    const r = await conector.findTimelineMarker(conexao, "nao-existe", DESDE_LONGE, 2);
    expect(r).toEqual({ achou: null, conclusiva: false, paginasLidas: 2 });
  });

  it("lista fora de ordem: inconclusiva (não dá para confiar)", async () => {
    const falso = criarNectarFalso({ ordemNotas: "embaralhada" });
    const { conector } = await contatoENotas(falso);
    falso.notasDeOutros(10);
    const r = await conector.findTimelineMarker(conexao, "nao-existe", DESDE_LONGE, 5);
    expect(r.achou).toBeNull();
    expect(r.conclusiva).toBe(false);
  });

  it("lote rodando: 300 notas de outros por cima e teto de 2 páginas de 50 notas: inconclusiva", async () => {
    const falso = criarNectarFalso({ tamanhoPagina: 50 });
    const { conector, nota } = await contatoENotas(falso);
    await nota("alvo-2");
    falso.notasDeOutros(300);
    // As 100 notas lidas são todas de outros e mais novas que o início da operação.
    const r = await conector.findTimelineMarker(conexao, "alvo-2", DESDE_LONGE, 2);
    expect(r).toEqual({ achou: null, conclusiva: false, paginasLidas: 2 });
    // Com páginas suficientes, a mesma procura acha.
    expect((await conector.findTimelineMarker(conexao, "alvo-2", DESDE_LONGE, 10)).achou).not.toBeNull();
  });

  it("lista que acabou sem o marcador: conclusiva", async () => {
    const falso = criarNectarFalso();
    const { conector } = await contatoENotas(falso);
    expect(await conector.findTimelineMarker(conexao, "x", DESDE_LONGE, 5)).toEqual({ achou: null, conclusiva: true, paginasLidas: 1 });
  });

  it("o marcador é fechado: #12 não casa com #123, e as partes (:i) casam", async () => {
    const falso = criarNectarFalso();
    const { conector, nota } = await contatoENotas(falso);
    await nota("123");
    expect((await conector.findTimelineMarker(conexao, "12", DESDE_LONGE, 5)).achou).toBeNull();
    const parte = await conector.appendTimelineEntry(conexao, { assunto: "a", descricaoHtml: "(parte 2 de 3)<br>[CRM Agro #ficha:abc:r2:2]", contatoId: "1" });
    expect((await conector.findTimelineMarker(conexao, "ficha:abc:r2", DESDE_LONGE, 5)).achou).toEqual({ id: parte.id });
  });
});

describe("N3: resultado incerto e privacidade do erro", () => {
  it("tempo esgotado depois de gravar o POST /contatos/: CrmResultadoIncerto, e o contato existe no Nectar", async () => {
    const falso = criarNectarFalso({ tempoEsgotadoDepoisDeGravar: [/^\/contatos\/$/] });
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const e = await erroDe(() => conector.createContact(conexao, { nome: "Maria", constante: 3, ativo: true, codigo: "c-1" }));
    expect(e).toBeInstanceOf(CrmResultadoIncerto);
    expect(falso.dados.contatos).toHaveLength(1);
    // Depois, a busca pelo código o encontra (é assim que o motor resolve o incerto).
    falso.configurar({ tempoEsgotadoDepoisDeGravar: [] });
    expect(await conector.findContact(conexao, { codigo: "c-1" })).toHaveLength(1);
  });

  it("um erro de validação (400) não é resultado incerto e não dispara o tempo esgotado depois de gravar", async () => {
    const falso = criarNectarFalso({ tempoEsgotadoDepoisDeGravar: [/^\/contatos\/$/] });
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const e = await erroDe(() => conector.createContact(conexao, { nome: "", constante: 3 }));
    expect(e).toBeInstanceOf(CrmDadoInvalido);
    expect(falso.dados.contatos).toHaveLength(0);
  });

  it("erro de busca por CPF ou e-mail nunca leva o valor: 500 pelo conector e 404 pelo cliente", async () => {
    const falso = criarNectarFalso({ falhas: [{ caminho: /^\/contatos\/(cpf|email)\//, status: 500 }] });
    const conector = criarConectorNectar({ transporte: falso.transporte });
    const eCpf = await erroDe(() => conector.findContact(conexao, { cpf: "12345678909" }));
    const eMail = await erroDe(() => conector.findContact(conexao, { email: "maria@cliente.com" }));
    for (const [e, valor] of [[eCpf, "12345678909"], [eMail, "maria@cliente.com"]] as const) {
      expect(e).toBeInstanceOf(CrmIndisponivel);
      expect(e.message).not.toContain(valor);
      expect(e.message).toContain(":valor");
    }
    // Pelo cliente cru, o 404 também sai sem o valor (o conector o trata como lista vazia).
    const cliente = criarClienteNectar({ token: TOKEN_FALSO_NECTAR, transporte: criarNectarFalso().transporte });
    const e404 = await erroDe(() => cliente.get(`/contatos/cpf/${segmento("12345678909")}`, z.unknown()));
    expect(e404).toBeInstanceOf(CrmNaoEncontrado);
    expect(e404.message).not.toContain("12345678909");
    expect(e404.message).toContain("/contatos/cpf/:valor");
  });
});
