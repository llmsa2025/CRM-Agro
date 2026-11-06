import { describe, expect, it } from "vitest";
import { CNAES_IBGE } from "./cnaes-ibge";
import {
  CNAES_SUGERIDOS,
  FORMULARIO_VAZIO,
  LIMITE_BUSCA_MAX,
  LIMITE_BUSCA_PADRAO,
  cnaeFormatado,
  cnaeNormalizado,
  dominioAtivo,
  filtrarCnaes,
  lerCnaes,
  lerValorEmReais,
  limiteDaBusca,
  montarPedido,
} from "./captacao-filtros";

/** Regras puras da aba "Por filtros": o que a pessoa digita vira o pedido ao servidor (ou um aviso). */
describe("CNAE", () => {
  it("aceita os formatos que a pessoa copia da nota fiscal ou do site", () => {
    expect(cnaeNormalizado("0115-6/00")).toBe("0115600");
    expect(cnaeNormalizado("115600")).toBe("0115600");
    expect(cnaeNormalizado("4683400")).toBe("4683400");
    expect(cnaeNormalizado("")).toBeNull();
    expect(cnaeNormalizado("abc")).toBeNull();
    expect(cnaeNormalizado("12345678")).toBeNull();
    expect(cnaeNormalizado("0000000")).toBeNull();
    expect(cnaeFormatado("0115600")).toBe("0115-6/00");
  });

  it("lê vários de uma vez, sem repetir, e separa o que não deu para ler", () => {
    expect(lerCnaes("0115-6/00, 0151201; 115600\n4683400")).toEqual({ codigos: ["0115600", "0151201", "4683400"], invalidos: [] });
    expect(lerCnaes("0115600 xx 99999999")).toEqual({ codigos: ["0115600"], invalidos: ["xx", "99999999"] });
    expect(lerCnaes("")).toEqual({ codigos: [], invalidos: [] });
  });

  it("as sugestões são CNAEs válidos e sem repetição", () => {
    const codigos = CNAES_SUGERIDOS.map((c) => c.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of codigos) expect(cnaeNormalizado(c)).toBe(c);
  });
});

describe("valor em reais e quantidade", () => {
  it("lê no jeito brasileiro", () => {
    expect(lerValorEmReais("")).toBeNull();
    expect(lerValorEmReais("500000")).toBe(500000);
    expect(lerValorEmReais("1.500.000")).toBe(1500000);
    expect(lerValorEmReais("R$ 1.500.000,50")).toBe(1500000.5);
    expect(lerValorEmReais("2 milhões")).toBe("invalido");
    expect(lerValorEmReais("-5")).toBe("invalido");
  });

  it("quantidade: 1 a 500; vazio, zero ou lixo voltam ao padrão", () => {
    expect(limiteDaBusca("250")).toBe(250);
    expect(limiteDaBusca("9999")).toBe(LIMITE_BUSCA_MAX);
    expect(limiteDaBusca("")).toBe(LIMITE_BUSCA_PADRAO);
    expect(limiteDaBusca("0")).toBe(LIMITE_BUSCA_PADRAO);
    expect(limiteDaBusca("abc")).toBe(LIMITE_BUSCA_PADRAO);
    expect(limiteDaBusca(37.9)).toBe(37);
  });
});

describe("montarPedido", () => {
  const base = { ...FORMULARIO_VAZIO };

  it("padrões seguros: só ativas, sem empresário individual e MEI, sem checar WhatsApp", () => {
    const r = montarPedido({ ...base, cnaesTexto: "0115-6/00" });
    expect(r).toMatchObject({
      ok: true,
      pedido: { cnaes: ["0115600"], ufs: [], cidades: [], soAtivas: true, excluirPessoa: true, checarWhatsApp: false, completarContato: false, limite: 100 },
    });
  });

  it("monta estado, cidade, porte, capital e datas", () => {
    const r = montarPedido({
      ...base,
      cnaesTexto: "0115600",
      uf: "MT",
      cidades: [" Sorriso ", "Sinop", "Sorriso"],
      portes: ["micro", "pequeno"],
      capitalMin: "100.000",
      capitalMax: "5.000.000",
      abertaDesde: "2010-01-01",
      abertaAte: "2020-12-31",
      limite: "300",
    });
    expect(r).toMatchObject({
      ok: true,
      pedido: { ufs: ["MT"], cidades: ["Sorriso", "Sinop"], portes: ["micro", "pequeno"], capitalMin: 100000, capitalMax: 5000000, abertaDesde: "2010-01-01", abertaAte: "2020-12-31", limite: 300 },
    });
  });

  it("avisa o que corrigir, sem mandar nada ao servidor", () => {
    expect(montarPedido(base)).toMatchObject({ ok: false, erro: expect.stringMatching(/ao menos um CNAE ou um estado/) });
    expect(montarPedido({ ...base, cnaesTexto: "xx" })).toMatchObject({ ok: false, erro: expect.stringMatching(/CNAE inválido: xx/) });
    expect(montarPedido({ ...base, cnaesTexto: "0115600", cidades: ["Sorriso"] })).toMatchObject({ ok: false, erro: expect.stringMatching(/estado das cidades/) });
    expect(montarPedido({ ...base, uf: "MT", capitalMin: "abc" })).toMatchObject({ ok: false, erro: expect.stringMatching(/valor em reais/) });
    expect(montarPedido({ ...base, uf: "MT", capitalMin: "10", capitalMax: "5" })).toMatchObject({ ok: false, erro: expect.stringMatching(/mínimo é maior/) });
    expect(montarPedido({ ...base, uf: "MT", abertaDesde: "2020-01-01", abertaAte: "2019-01-01" })).toMatchObject({ ok: false, erro: expect.stringMatching(/data inicial/) });
  });

  it("os textos da tela não usam travessão nem meia-risca (regra de texto do CRM Agro)", () => {
    const textos = [
      ...CNAES_SUGERIDOS.map((c) => c.nome),
      ...[{}, { cnaesTexto: "xx" }, { uf: "MT", capitalMin: "abc" }].map((o) => {
        const r = montarPedido({ ...base, ...o });
        return r.ok ? "" : r.erro;
      }),
    ];
    for (const t of textos) expect(t).not.toMatch(/[—–]/);
  });
});

describe("várias cidades", () => {
  const base = { ...FORMULARIO_VAZIO, cnaesTexto: "0115600", uf: "MT" };
  it("manda todas as cidades escolhidas, sem repetir", () => {
    expect(montarPedido({ ...base, cidades: ["Sorriso", "Sinop", "sorriso", " Sinop "] })).toMatchObject({ ok: true, pedido: { cidades: ["Sorriso", "Sinop", "sorriso"] } });
  });
  it("recusa passar do teto de cidades", () => {
    const muitas = Array.from({ length: 21 }, (_, i) => `Cidade ${i}`);
    expect(montarPedido({ ...base, cidades: muitas })).toMatchObject({ ok: false, erro: expect.stringMatching(/no máximo 20 cidades/) });
  });
});

describe("opções novas da busca", () => {
  const base = { ...FORMULARIO_VAZIO, cnaesTexto: "0115600" };
  const pedido = (o: Partial<typeof FORMULARIO_VAZIO>) => {
    const r = montarPedido({ ...base, ...o });
    if (!r.ok) throw new Error(r.erro);
    return r.pedido;
  };

  it("padrões: sem secundário, sem já cadastradas, ignora contabilidade, sem filtro de e-mail", () => {
    expect(pedido({})).toMatchObject({ incluirJaCadastradas: false, cnaeSecundario: false, ignorarEmailContabilidade: true, soComEmail: false, emailDominioAtivo: false, emailDominio: "", completarContato: false });
  });

  it("caixa desmarcada com texto: o texto é ignorado e nada liga", () => {
    expect(dominioAtivo({ emailDominioAtivo: false, emailDominio: "grupo" })).toBe(false);
    expect(pedido({ emailDominioAtivo: false, emailDominio: "grupo" })).toMatchObject({ emailDominioAtivo: false, emailDominio: "", soComEmail: false, completarContato: false });
  });

  it("caixa marcada e campo vazio (ou só @ e vírgula): não filtra e não liga 'Só com e-mail'", () => {
    for (const texto of ["", "   ", "@", " , ; "]) {
      expect(dominioAtivo({ emailDominioAtivo: true, emailDominio: texto })).toBe(false);
      expect(pedido({ emailDominioAtivo: true, emailDominio: texto })).toMatchObject({ emailDominioAtivo: false, emailDominio: "", soComEmail: false, completarContato: false });
    }
  });

  it("caixa marcada com palavra: vale e implica 'Só com e-mail' e a consulta de cada empresa", () => {
    expect(pedido({ emailDominioAtivo: true, emailDominio: " @grupo, agro " })).toMatchObject({ emailDominioAtivo: true, emailDominio: "@grupo, agro", soComEmail: true, completarContato: true });
  });

  it("'Só com e-mail' sozinho também pede a consulta de cada empresa", () => {
    expect(pedido({ soComEmail: true })).toMatchObject({ soComEmail: true, completarContato: true });
  });
});

describe("lista completa de CNAEs (IBGE)", () => {
  it("tem a tabela toda, com código de 7 dígitos e sem repetir", () => {
    expect(CNAES_IBGE.length).toBeGreaterThan(1300);
    const codigos = CNAES_IBGE.map(([c]) => c);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of codigos) expect(c).toMatch(/^\d{7}$/);
  });

  it("todos os CNAEs sugeridos existem na tabela", () => {
    const todos = new Set(CNAES_IBGE.map(([c]) => c));
    for (const c of CNAES_SUGERIDOS) expect(todos.has(c.codigo), c.codigo).toBe(true);
  });

  it("busca por código (com ou sem pontuação) e por texto sem acento", () => {
    expect(filtrarCnaes(CNAES_IBGE, "0115-6/00").itens.map(([c]) => c)).toEqual(["0115600"]);
    expect(filtrarCnaes(CNAES_IBGE, "0115").itens.every(([c]) => c.includes("0115"))).toBe(true);
    const soja = filtrarCnaes(CNAES_IBGE, "CULTIVO soja");
    expect(soja.itens.map(([c]) => c)).toContain("0115600");
    expect(filtrarCnaes(CNAES_IBGE, "algodao").itens.map(([c]) => c)).toContain("0112101");
  });

  it("sem busca mostra o começo da lista e informa o total; texto sem resultado volta vazio", () => {
    const r = filtrarCnaes(CNAES_IBGE, "", 50);
    expect(r.itens).toHaveLength(50);
    expect(r.total).toBe(CNAES_IBGE.length);
    expect(filtrarCnaes(CNAES_IBGE, "zzzzzz").total).toBe(0);
  });

  it("os textos da tabela não usam travessão nem meia-risca", () => {
    for (const [, nome] of CNAES_IBGE) expect(nome).not.toMatch(/[—–]/);
  });
});
