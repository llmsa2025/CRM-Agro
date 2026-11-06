/** N3: o mapper CRM Agro para Nectar (puro): criação, atualização sem apagar, card, nota e repetidos. */
import { describe, expect, it } from "vitest";
import type { ContatoLocal, ContatoRemoto } from "../../contract";
import {
  atualizacaoDeContato,
  contatoParaCriacao,
  escaparHtml,
  escolherEntreRepetidos,
  LIMITE_NOTA,
  modeloDoNomeDoCard,
  montarNota,
  nomeCompleto,
  oportunidadeParaCriacao,
  qualificacaoParaCriacao,
} from "./mapper";

const local = (p: Partial<ContatoLocal> = {}): ContatoLocal => ({
  id: "contato-1",
  nome: "Maria",
  sobrenome: "Silva",
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

const remoto = (p: Partial<ContatoRemoto> = {}): ContatoRemoto => ({
  id: "10",
  nome: "Maria Silva",
  emails: [],
  telefones: [],
  listas: [],
  codigo: null,
  constante: 3,
  empresaAtualId: null,
  cargo: null,
  blocked: false,
  ...p,
});

const OPTS_CRIACAO = { constantePadrao: 3 as const, cpfLigado: false, formatoPreferido: "parenteses_hifen" as const, enderecoLiberado: false };
const OPTS_UPDATE = { criadoPeloCrmAgro: false, manterAtualizados: [] as ("nome" | "cargo" | "responsavel" | "endereco")[], cpfLigado: false, formatoPreferido: "parenteses_hifen" as const };

describe("contatoParaCriacao", () => {
  it("campo vazio não vai (nada de null, texto vazio ou lista vazia)", () => {
    const { saida } = contatoParaCriacao(local({ sobrenome: "", cargo: "  ", origem: "", linkedin: "", tagNomes: [], emails: [], telefonesE164: [] }), OPTS_CRIACAO);
    expect(Object.keys(saida).sort()).toEqual(["ativo", "codigo", "constante", "nome"]);
    for (const v of Object.values(saida)) {
      expect(v).not.toBeNull();
      expect(v).not.toBe("");
      expect(Array.isArray(v) && v.length === 0).toBe(false);
    }
    expect(saida.nome).toBe("Maria");
  });

  it("leva nome completo, e-mails em minúsculas sem repetir, telefone no formato da conta e etiquetas", () => {
    const { saida, avisos } = contatoParaCriacao(
      local({
        emails: ["Maria@X.com", "maria@x.com", "b@x.com"],
        telefonesE164: ["+5562999998888"],
        tagNomes: ["Feira", "feira", "Cliente VIP"],
        cargo: "Diretora",
        origem: "Instagram",
        faturamentoAnual: 1_500_000,
      }),
      OPTS_CRIACAO,
    );
    expect(avisos).toEqual([]);
    expect(saida).toMatchObject({
      nome: "Maria Silva",
      emails: ["maria@x.com", "b@x.com"],
      telefones: ["(62) 99999-8888"],
      listas: [{ nome: "Feira" }, { nome: "Cliente VIP" }],
      cargo: "Diretora",
      origem: "Instagram",
      receitaAnual: 1_500_000,
      ativo: true,
      codigo: "contato-1",
    });
  });

  it("faturamento zero não vai", () => {
    expect(contatoParaCriacao(local({ faturamentoAnual: 0 }), OPTS_CRIACAO).saida.receitaAnual).toBeUndefined();
  });

  it("LinkedIn de 51 caracteres não vai, e sai o aviso; 50 vai", () => {
    const longo = contatoParaCriacao(local({ linkedin: "x".repeat(51) }), OPTS_CRIACAO);
    expect(longo.saida.linkedin).toBeUndefined();
    expect(longo.avisos).toEqual(["LinkedIn com mais de 50 caracteres: foi só na Ficha do CRM Agro"]);
    const ok = contatoParaCriacao(local({ linkedin: "x".repeat(50) }), OPTS_CRIACAO);
    expect(ok.saida.linkedin).toHaveLength(50);
    expect(ok.avisos).toEqual([]);
  });

  it("constante: cliente vira 0; os outros, inclusive opt_out, vão com a padrão", () => {
    const de = (relacionamentoStatus: ContatoLocal["relacionamentoStatus"]) => contatoParaCriacao(local({ relacionamentoStatus }), { ...OPTS_CRIACAO, constantePadrao: 2 }).saida.constante;
    expect(de("cliente")).toBe(0);
    expect(de("opt_out")).toBe(2);
    expect(de("novo")).toBe(2);
    expect(de("ja_conversou")).toBe(2);
  });

  it("CPF só com cpfLigado", () => {
    expect(contatoParaCriacao(local({ cpf: "12345678909" }), OPTS_CRIACAO).saida.cpf).toBeUndefined();
    expect(contatoParaCriacao(local({ cpf: "12345678909" }), { ...OPTS_CRIACAO, cpfLigado: true }).saida.cpf).toBe("12345678909");
    expect(contatoParaCriacao(local({ cpf: null }), { ...OPTS_CRIACAO, cpfLigado: true }).saida.cpf).toBeUndefined();
  });

  it("endereço só com enderecoLiberado (G6-D7)", () => {
    const l = local({ cidade: "Rio Verde", estado: "GO" });
    expect(contatoParaCriacao(l, OPTS_CRIACAO).saida).not.toHaveProperty("regiaoMunicipio");
    expect(contatoParaCriacao(l, { ...OPTS_CRIACAO, enderecoLiberado: true }).saida).toMatchObject({ regiaoMunicipio: "Rio Verde", regiaoEstado: "GO" });
  });

  it("responsável (usuário ou fila) e empresa vão só quando informados", () => {
    expect(contatoParaCriacao(local(), { ...OPTS_CRIACAO, responsavel: { responsavel: { id: "7" } }, empresaAtualId: "55" }).saida).toMatchObject({
      responsavel: { id: "7" },
      empresaAtual: { id: "55" },
    });
    const fila = contatoParaCriacao(local(), { ...OPTS_CRIACAO, responsavel: { queue: { id: "12" } } }).saida;
    expect(fila.queue).toEqual({ id: "12" });
    expect(fila).not.toHaveProperty("responsavel");
    expect(contatoParaCriacao(local(), OPTS_CRIACAO).saida).not.toHaveProperty("empresaAtual");
  });
});

describe("atualizacaoDeContato (nunca apaga)", () => {
  it("listas só crescem: e-mail comparado em minúsculas, manda a lista inteira", () => {
    const mud = atualizacaoDeContato(remoto({ emails: ["a@x.com"] }), local({ emails: ["A@x.com", "b@x.com"] }), OPTS_UPDATE);
    expect(mud?.emails).toEqual(["a@x.com", "b@x.com"]);
  });

  it("guarda o que o vendedor pôs no Nectar (e-mail e telefone) e soma o novo", () => {
    const mud = atualizacaoDeContato(
      remoto({ emails: ["a@x.com", "vendedor@x.com"], telefones: ["(11) 3222-1111"] }),
      local({ emails: ["novo@x.com"], telefonesE164: ["+5562999998888"] }),
      OPTS_UPDATE,
    );
    expect(mud?.emails).toEqual(["a@x.com", "vendedor@x.com", "novo@x.com"]);
    expect(mud?.telefones).toEqual(["(11) 3222-1111", "(62) 99999-8888"]);
  });

  it("telefone local cuja variante já está no Nectar não entra", () => {
    for (const jaLa of ["62999998888", "(62) 99999-8888", "+5562999998888", "6299998888", "62 99999 8888"]) {
      expect(atualizacaoDeContato(remoto({ telefones: [jaLa] }), local({ telefonesE164: ["+5562999998888"] }), OPTS_UPDATE)).toBeNull();
    }
  });

  it("etiquetas pelo nome, sem diferença de maiúscula", () => {
    const mud = atualizacaoDeContato(remoto({ listas: ["Feira"] }), local({ tagNomes: ["feira", "Nova"] }), OPTS_UPDATE);
    expect(mud?.listas).toEqual([{ nome: "Feira" }, { nome: "Nova" }]);
    expect(atualizacaoDeContato(remoto({ listas: ["Feira"] }), local({ tagNomes: ["FEIRA"] }), OPTS_UPDATE)).toBeNull();
  });

  it("nada muda: null", () => {
    expect(atualizacaoDeContato(remoto({ emails: ["a@x.com"], cargo: "Dona" }), local({ emails: ["a@x.com"], cargo: "Outra" }), OPTS_UPDATE)).toBeNull();
  });

  it("nunca manda o codigo, nem no contato criado pelo CRM Agro", () => {
    const mud = atualizacaoDeContato(remoto({ codigo: null }), local({ emails: ["novo@x.com"] }), { ...OPTS_UPDATE, criadoPeloCrmAgro: true, manterAtualizados: ["nome", "cargo"] });
    expect(mud).not.toHaveProperty("codigo");
    expect(JSON.stringify(mud)).not.toContain("contato-1");
  });

  it("contato que já existia: só preenche o que está vazio (nome e cargo preenchidos ficam)", () => {
    const jaExistia = atualizacaoDeContato(
      remoto({ nome: "Maria da Silva", cargo: "Gerente", empresaAtualId: "9" }),
      local({ nome: "Maria", sobrenome: "S.", cargo: "Diretora" }),
      { ...OPTS_UPDATE, manterAtualizados: ["nome", "cargo"], empresaAtualId: "55" },
    );
    expect(jaExistia).toBeNull();
    const vazio = atualizacaoDeContato(remoto({ nome: "", cargo: null, empresaAtualId: null }), local({ cargo: "Diretora" }), { ...OPTS_UPDATE, empresaAtualId: "55" });
    expect(vazio).toEqual({ nome: "Maria Silva", cargo: "Diretora", empresaAtual: { id: "55" } });
  });

  it("contato criado pelo CRM Agro: nome e cargo escolhidos em manterAtualizados são sobrescritos quando diferentes", () => {
    const opts = { ...OPTS_UPDATE, criadoPeloCrmAgro: true, manterAtualizados: ["cargo" as const] };
    const mud = atualizacaoDeContato(remoto({ nome: "Maria Antiga", cargo: "Gerente" }), local({ nome: "Maria", cargo: "Diretora" }), opts);
    // Só o cargo estava em "manter atualizado": o nome preenchido fica.
    expect(mud).toEqual({ cargo: "Diretora" });
    const comNome = atualizacaoDeContato(remoto({ nome: "Maria Antiga" }), local(), { ...opts, manterAtualizados: ["nome"] });
    expect(comNome).toEqual({ nome: "Maria Silva" });
    // Local vazio nunca apaga o remoto.
    expect(atualizacaoDeContato(remoto({ cargo: "Gerente" }), local({ cargo: null }), opts)).toBeNull();
  });
});

describe("card: oportunidade e qualificação", () => {
  it("oportunidade B2B com empresa: cliente é a empresa e contato é a pessoa", () => {
    const o = oportunidadeParaCriacao({ nomeCard: "Maria (Fazenda X)", pessoaId: "10", empresaId: "20", funil: { id: "1", modeloVenda: "b2b" }, etapaSequencia: 2, valor: 5000, optOut: false });
    expect(o).toEqual({ nome: "Maria (Fazenda X)", cliente: { id: "20" }, contato: { id: "10" }, funilVenda: { id: "1" }, etapa: 2, valorAvulso: 5000 });
    expect(o).not.toHaveProperty("status");
  });

  it("oportunidade B2C, ou B2B sem empresa: cliente é a pessoa e não vai contato", () => {
    const b2c = oportunidadeParaCriacao({ nomeCard: "Maria", pessoaId: "10", empresaId: "20", funil: { id: "3", modeloVenda: "b2c" }, etapaSequencia: 1, optOut: false });
    expect(b2c.cliente).toEqual({ id: "10" });
    expect(b2c).not.toHaveProperty("contato");
    const semEmpresa = oportunidadeParaCriacao({ nomeCard: "Maria", pessoaId: "10", funil: { id: "1", modeloVenda: "b2b" }, etapaSequencia: 1, optOut: false });
    expect(semEmpresa.cliente).toEqual({ id: "10" });
    expect(semEmpresa).not.toHaveProperty("contato");
  });

  it("valorAvulso só se maior que zero; responsável ou fila só quando informados", () => {
    const base = { nomeCard: "M", pessoaId: "10", funil: { id: "1", modeloVenda: "b2c" as const }, etapaSequencia: 1, optOut: false };
    expect(oportunidadeParaCriacao({ ...base, valor: 0 })).not.toHaveProperty("valorAvulso");
    expect(oportunidadeParaCriacao({ ...base, valor: null })).not.toHaveProperty("valorAvulso");
    expect(oportunidadeParaCriacao({ ...base, responsavel: { responsavel: { login: "ana" } } }).responsavel).toEqual({ login: "ana" });
    expect(oportunidadeParaCriacao({ ...base, responsavel: { queue: { id: "12" } } }).queue).toEqual({ id: "12" });
    expect(oportunidadeParaCriacao(base)).not.toHaveProperty("responsavel");
  });

  it("qualificação: cliente é a pessoa, com status 1", () => {
    const q = qualificacaoParaCriacao({ nomeCard: "Maria", pessoaId: "10", funil: { id: "7" }, etapaSequencia: 1, optOut: false });
    expect(q).toEqual({ nome: "Maria", cliente: { id: "10" }, funilVenda: { id: "7" }, etapa: 1, status: 1 });
  });

  it("opt-out põe [OPT-OUT] no começo do nome do card (oportunidade e qualificação), com corte em 255", () => {
    const o = oportunidadeParaCriacao({ nomeCard: "Maria", pessoaId: "10", funil: { id: "1", modeloVenda: "b2c" }, etapaSequencia: 1, optOut: true });
    expect(o.nome).toBe("[OPT-OUT] Maria");
    const q = qualificacaoParaCriacao({ nomeCard: "x".repeat(300), pessoaId: "10", funil: { id: "7" }, etapaSequencia: 1, optOut: true });
    expect(q.nome.startsWith("[OPT-OUT] ")).toBe(true);
    expect(q.nome).toHaveLength(255);
  });

  it("modeloDoNomeDoCard: com e sem empresa, sem travessão", () => {
    expect(modeloDoNomeDoCard("Maria", "Fazenda X")).toBe("Maria (Fazenda X)");
    expect(modeloDoNomeDoCard("Maria", "  ")).toBe("Maria");
    expect(modeloDoNomeDoCard(" Maria ", null)).toBe("Maria");
    expect(modeloDoNomeDoCard("Maria", "Fazenda X")).not.toMatch(/[—–]/);
  });

  it("nomeCompleto: junta, tira espaço sobrando e corta em 255", () => {
    expect(nomeCompleto(" Maria ", " Silva ")).toBe("Maria Silva");
    expect(nomeCompleto("Maria", null)).toBe("Maria");
    expect(nomeCompleto("x".repeat(300), "y")).toHaveLength(255);
  });
});

describe("montarNota", () => {
  const base = { assunto: "CRM Agro · Nota", aconteceuEm: new Date("2026-09-29T17:05:00Z"), autorNome: "Maria", marcador: "abc123" };

  it("primeira linha com data no fuso de São Paulo e autor; última com o marcador", () => {
    const { assunto, partes } = montarNota({ ...base, linhas: ["Ligou e não atendeu"] });
    expect(assunto).toBe("CRM Agro · Nota");
    expect(partes).toHaveLength(1);
    const linhas = partes[0]!.split("<br>");
    expect(linhas[0]).toBe("Aconteceu no CRM Agro em 29/09/2026 14:05 · por Maria");
    expect(linhas[1]).toBe("Ligou e não atendeu");
    expect(linhas[linhas.length - 1]).toBe("[CRM Agro #abc123]");
  });

  it("sem autor: 'autor não registrado'", () => {
    const { partes } = montarNota({ ...base, autorNome: null, linhas: ["x"] });
    expect(partes[0]!.split("<br>")[0]).toBe("Aconteceu no CRM Agro em 29/09/2026 14:05 · autor não registrado");
  });

  it("virada do dia no fuso de São Paulo (02:30 UTC ainda é o dia anterior)", () => {
    const { partes } = montarNota({ ...base, aconteceuEm: new Date("2026-10-01T02:30:00Z"), linhas: [] });
    expect(partes[0]!.startsWith("Aconteceu no CRM Agro em 30/09/2026 23:30")).toBe(true);
  });

  it("escapa o HTML e vira quebra de linha em <br>", () => {
    const { partes } = montarNota({ ...base, autorNome: "Zé <b>", linhas: ["<script>alert('x')</script> & \"aspas\"\nsegunda linha"] });
    const t = partes[0]!;
    expect(t).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;aspas&quot;<br>segunda linha");
    expect(t).toContain("por Zé &lt;b&gt;");
    expect(t).not.toContain("<script>");
    expect(t).not.toContain("<b>");
    expect(escaparHtml("a&b")).toBe("a&amp;b");
  });

  it("assunto cortado em 255", () => {
    expect(montarNota({ ...base, assunto: "a".repeat(400), linhas: [] }).assunto).toHaveLength(255);
  });

  it("45 mil caracteres viram 3 partes, com os marcadores :1, :2 e :3", () => {
    // "ç" não aparece no cabeçalho, no rodapé nem no marcador: dá para contar o que veio do texto.
    const { partes } = montarNota({ ...base, linhas: ["ç".repeat(45_000)] });
    expect(partes).toHaveLength(3);
    partes.forEach((parte, i) => {
      expect(parte.length).toBeLessThanOrEqual(LIMITE_NOTA);
      expect(parte.startsWith(`(parte ${i + 1} de 3)`)).toBe(true);
      expect(parte.endsWith(`[CRM Agro #abc123:${i + 1}]`)).toBe(true);
    });
    // Nenhum caractere se perde na divisão.
    expect(partes.join("").match(/ç/g)!.length).toBe(45_000);
  });

  it("várias linhas longas: divide entre as linhas e cada parte cabe no limite", () => {
    const linhas = Array.from({ length: 450 }, (_, i) => `linha ${i} ${"b".repeat(90)}`);
    const { partes } = montarNota({ ...base, linhas });
    expect(partes.length).toBeGreaterThanOrEqual(3);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(LIMITE_NOTA);
    // Todas as linhas aparecem, na ordem, sem cortar nenhuma ao meio.
    const todas = partes.join("<br>");
    for (let i = 0; i < 450; i += 50) expect(todas).toContain(`linha ${i} `);
    const ordem = [...todas.matchAll(/linha (\d+) /g)].map((m) => Number(m[1]));
    expect(ordem).toEqual([...ordem].sort((a, b) => a - b));
  });

  it("dividir nunca corta no meio de uma entidade HTML (&amp;)", () => {
    const { partes } = montarNota({ ...base, linhas: ["&".repeat(50_000)] });
    expect(partes.length).toBeGreaterThan(2);
    for (const p of partes) {
      expect(p.length).toBeLessThanOrEqual(LIMITE_NOTA);
      // Cada "&" é sempre o começo de "&amp;" inteiro.
      expect(p.replace(/&amp;/g, "").includes("&")).toBe(false);
    }
  });

  it("nota que cabe no limite fica numa parte só e sem '(parte i de n)'", () => {
    const { partes } = montarNota({ ...base, linhas: ["c".repeat(15_000)] });
    expect(partes).toHaveLength(1);
    expect(partes[0]).not.toContain("(parte");
    expect(partes[0]!.endsWith("[CRM Agro #abc123]")).toBe(true);
  });
});

describe("escolherEntreRepetidos", () => {
  const alvo = { emails: ["maria@x.com"], telefonesE164: ["+5562999998888"] };

  it("1º critério: quem casa mais identificadores (e-mail em minúsculas, telefone por variantes)", () => {
    const r = escolherEntreRepetidos(
      [
        { id: "5", emails: ["MARIA@x.com"], telefones: [], temCardNoFunil: true },
        { id: "9", emails: ["maria@x.com"], telefones: ["(62) 99999-8888"], temCardNoFunil: false },
        { id: "2", emails: [], telefones: [], temCardNoFunil: false },
      ],
      alvo,
    );
    expect(r).toEqual({ escolhido: "9", outros: ["5", "2"] });
  });

  it("2º critério: empatando, quem já tem card no funil de destino", () => {
    const r = escolherEntreRepetidos(
      [
        { id: "3", emails: ["maria@x.com"], telefones: [], temCardNoFunil: false },
        { id: "8", emails: ["maria@x.com"], telefones: [], temCardNoFunil: true },
      ],
      alvo,
    );
    expect(r.escolhido).toBe("8");
    expect(r.outros).toEqual(["3"]);
  });

  it("3º critério: empatando de novo, o menor id (numérico, sem perder precisão em id grande)", () => {
    const iguais = (id: string) => ({ id, emails: ["maria@x.com"], telefones: [], temCardNoFunil: false });
    expect(escolherEntreRepetidos([iguais("10"), iguais("9"), iguais("100")], alvo).escolhido).toBe("9");
    expect(escolherEntreRepetidos([iguais("9007199254740993"), iguais("9007199254740992")], alvo).escolhido).toBe("9007199254740992");
    // Ids que não são números: ordem de texto.
    expect(escolherEntreRepetidos([iguais("b"), iguais("a")], alvo).escolhido).toBe("a");
  });

  it("um só candidato: ele mesmo, sem outros; nenhum candidato é erro nomeado", () => {
    expect(escolherEntreRepetidos([{ id: "1", emails: [], telefones: [], temCardNoFunil: false }], alvo)).toEqual({ escolhido: "1", outros: [] });
    expect(() => escolherEntreRepetidos([], alvo)).toThrowError(expect.objectContaining({ name: "CrmRequisitoFaltando" }));
  });
});
