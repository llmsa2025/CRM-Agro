import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FILTROS_LOCAIS_PADRAO,
  aprovaRegistro,
  buscarPaginaMinhaReceita,
  porteDoRegistro,
  resultadoDoRegistro,
  urlDaBusca,
  type RegistroMinhaReceita,
} from "./busca";
import { CnpjLookupFailed } from "./errors";
import { resultadoDoOpenCnpj } from "./opencnpj";

/** Registro no formato da Minha Receita (dados inventados). */
const reg = (o: Partial<RegistroMinhaReceita> = {}): RegistroMinhaReceita => ({
  cnpj: "11222333000181",
  razao_social: "AGROPECUARIA TESTE LTDA",
  nome_fantasia: "",
  situacao_cadastral: 2,
  descricao_situacao_cadastral: "ATIVA",
  data_inicio_atividade: "2015-03-10",
  cnae_fiscal: 115600,
  cnae_fiscal_descricao: "Cultivo de soja",
  cnaes_secundarios: [{ codigo: 111302, descricao: "Cultivo de milho" }],
  descricao_tipo_de_logradouro: "AVENIDA",
  logradouro: "DOS COQUEIROS",
  numero: "100",
  bairro: "CENTRO",
  municipio: "SORRISO",
  uf: "MT",
  ddd_telefone_1: "6635441234",
  ddd_telefone_2: "",
  email: null,
  porte: "EMPRESA DE PEQUENO PORTE",
  capital_social: 500000,
  codigo_natureza_juridica: 2062,
  opcao_pelo_mei: null,
  qsa: [{ nome_socio: "FULANA DE TESTE", qualificacao_socio: "Sócio-Administrador" }],
  ...o,
});

describe("aprovaRegistro (filtros que a fonte não faz)", () => {
  const f = FILTROS_LOCAIS_PADRAO;

  it("padrão: só ativas e sem empresário individual/MEI (pessoa física)", () => {
    expect(f.soAtivas).toBe(true);
    expect(f.excluirPessoa).toBe(true);
    expect(aprovaRegistro(reg(), f)).toBe(true);
    expect(aprovaRegistro(reg({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" }), f)).toBe(false);
    expect(aprovaRegistro(reg({ codigo_natureza_juridica: 2135 }), f)).toBe(false); // empresário individual
    expect(aprovaRegistro(reg({ opcao_pelo_mei: true }), f)).toBe(false); // MEI
    // desligando o filtro, a pessoa física passa (a decisão é de quem busca)
    expect(aprovaRegistro(reg({ codigo_natureza_juridica: 2135 }), { ...f, excluirPessoa: false })).toBe(true);
  });

  it("porte: micro, pequeno, demais; sem dado de porte não passa quando o filtro está ligado", () => {
    expect(porteDoRegistro("MICRO EMPRESA")).toBe("micro");
    expect(porteDoRegistro("EMPRESA DE PEQUENO PORTE")).toBe("pequeno");
    expect(porteDoRegistro("DEMAIS")).toBe("demais");
    expect(porteDoRegistro("NAO INFORMADO")).toBeNull();
    expect(aprovaRegistro(reg(), { ...f, portes: ["pequeno", "micro"] })).toBe(true);
    expect(aprovaRegistro(reg(), { ...f, portes: ["demais"] })).toBe(false);
    expect(aprovaRegistro(reg({ porte: null }), { ...f, portes: ["demais"] })).toBe(false);
  });

  it("capital social em faixa (inclusive nos limites)", () => {
    expect(aprovaRegistro(reg(), { ...f, capitalMin: 500000, capitalMax: 500000 })).toBe(true);
    expect(aprovaRegistro(reg(), { ...f, capitalMin: 500001 })).toBe(false);
    expect(aprovaRegistro(reg(), { ...f, capitalMax: 499999 })).toBe(false);
    expect(aprovaRegistro(reg({ capital_social: null }), { ...f, capitalMin: 1 })).toBe(false);
    expect(aprovaRegistro(reg({ capital_social: "250000" }), { ...f, capitalMin: 100000, capitalMax: 300000 })).toBe(true);
  });

  it("data de abertura em faixa; só com telefone", () => {
    expect(aprovaRegistro(reg(), { ...f, abertaDesde: "2015-03-10", abertaAte: "2015-03-10" })).toBe(true);
    expect(aprovaRegistro(reg(), { ...f, abertaDesde: "2016-01-01" })).toBe(false);
    expect(aprovaRegistro(reg(), { ...f, abertaAte: "2014-12-31" })).toBe(false);
    expect(aprovaRegistro(reg({ data_inicio_atividade: null }), { ...f, abertaDesde: "2000-01-01" })).toBe(false);
    expect(aprovaRegistro(reg({ ddd_telefone_1: "", ddd_telefone_2: "" }), { ...f, soComTelefone: true })).toBe(false);
    expect(aprovaRegistro(reg({ ddd_telefone_1: "", ddd_telefone_2: "6633221100" }), { ...f, soComTelefone: true })).toBe(true);
  });

  it("só com telefone VÁLIDO: sem DDD, cortado, zerado ou repetido não vale; celular de 11 dígitos vale", () => {
    const com = (t: string) => aprovaRegistro(reg({ ddd_telefone_1: t, ddd_telefone_2: "" }), { ...f, soComTelefone: true });
    expect(com("12345")).toBe(false);
    expect(com("0")).toBe(false);
    expect(com("0000000000")).toBe(false);
    expect(com("999999999")).toBe(false);
    expect(com("66999887766")).toBe(true);
    expect(com("(66) 3322-1100")).toBe(true);
  });

  it("CNAE principal: com a lista, só passa quem tem o principal na lista (o secundário não basta)", () => {
    const secundario = reg({ cnae_fiscal: 151201, cnaes_secundarios: [{ codigo: 115600, descricao: "Cultivo de soja" }] });
    expect(aprovaRegistro(secundario, { ...f, cnaesPrincipais: ["0115600"] })).toBe(false);
    expect(aprovaRegistro(reg({ cnae_fiscal: 115600 }), { ...f, cnaesPrincipais: ["0115600", "0111302"] })).toBe(true);
    // Sem a lista (ou vazia), o secundário também vale (a fonte já filtrou por principal OU secundário).
    expect(aprovaRegistro(secundario, { ...f, cnaesPrincipais: [] })).toBe(true);
    expect(aprovaRegistro(secundario, f)).toBe(true);
  });
});

describe("resultadoDoRegistro (Minha Receita → formato comum de CNPJ)", () => {
  it("normaliza campos, marca fonte e parcial, e não inventa e-mail", () => {
    const r = resultadoDoRegistro(reg())!;
    expect(r).toMatchObject({
      cnpj: "11222333000181",
      razaoSocial: "AGROPECUARIA TESTE LTDA",
      nomeFantasia: null,
      nomeSocio: "FULANA DE TESTE",
      nome: "FULANA DE TESTE",
      cnae: "0115600",
      cnaeDescricao: "Cultivo de soja",
      cnaesSecundarios: [{ codigo: "0111302", descricao: "Cultivo de milho" }],
      cidade: "SORRISO",
      uf: "MT",
      telefone: "(66) 3544-1234",
      email: null,
      endereco: "AVENIDA DOS COQUEIROS, 100, CENTRO",
      dataAbertura: "2015-03-10",
      fonte: "minhareceita",
      parcial: true,
      porte: "EMPRESA DE PEQUENO PORTE",
      capitalSocial: 500000,
      ies: [],
    });
    expect(r.socios).toEqual([{ nome: "FULANA DE TESTE", qualificacao: "Sócio-Administrador" }]);
  });

  it("CNPJ que não tem 14 dígitos é descartado", () => {
    expect(resultadoDoRegistro(reg({ cnpj: "123" }))).toBeNull();
    expect(resultadoDoRegistro(reg({ cnpj: undefined }))).toBeNull();
  });
});

describe("urlDaBusca", () => {
  it("repete os parâmetros, usa UF minúscula e respeita o teto de 1.024 por página", () => {
    const u = new URL(urlDaBusca({ cnaes: ["0115600", "0151201"], ufs: ["MT"], municipios: [5107925] }, "42", 5000));
    expect(u.origin + u.pathname).toBe("https://minhareceita.org/");
    expect(u.searchParams.getAll("cnae")).toEqual(["0115600", "0151201"]);
    expect(u.searchParams.getAll("uf")).toEqual(["mt"]);
    expect(u.searchParams.getAll("municipio")).toEqual(["5107925"]);
    expect(u.searchParams.get("limit")).toBe("1024");
    expect(u.searchParams.get("cursor")).toBe("42");
  });
});

describe("buscarPaginaMinhaReceita (fetch falso)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const filtros = { cnaes: ["0115600"], ufs: ["MT"], municipios: [] };

  it("lê a página e o cursor; sem cursor = última página", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [reg()], cursor: "77" }), { status: 200 })));
    expect(await buscarPaginaMinhaReceita(filtros, null)).toEqual({ registros: [reg()], cursor: "77" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [reg()] }), { status: 200 })));
    expect((await buscarPaginaMinhaReceita(filtros, "77")).cursor).toBeNull();
  });

  it("recusa busca sem nenhum filtro (a fonte redireciona para a documentação) sem ir à rede", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(buscarPaginaMinhaReceita({ cnaes: [], ufs: [], municipios: [] }, null)).rejects.toBeInstanceOf(CnpjLookupFailed);
    expect(f).not.toHaveBeenCalled();
  });

  it("erro HTTP, JSON inválido e rede viram CnpjLookupFailed; o pedido tem tempo máximo", async () => {
    const chamadas: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => { chamadas.push(init!); return new Response("x", { status: 400 }); }));
    await expect(buscarPaginaMinhaReceita(filtros, null)).rejects.toThrow(/HTTP 400/);
    expect(chamadas[0]!.signal).toBeInstanceOf(AbortSignal);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(buscarPaginaMinhaReceita(filtros, null)).rejects.toThrow(/não é JSON/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("caiu"); }));
    await expect(buscarPaginaMinhaReceita(filtros, null)).rejects.toThrow(/erro de rede/);
  });
});

describe("resultadoDoOpenCnpj", () => {
  it("capital social em pt-BR e en-US, telefone que não é fax e sem IE", () => {
    const base = { razao_social: "EMPRESA X", telefones: [{ ddd: "66", numero: "999", is_fax: false }, { ddd: "66", numero: "35441234", is_fax: false }] };
    expect(resultadoDoOpenCnpj("11222333000181", { ...base, capital_social: "1.234.567,89" }).capitalSocial).toBe(1234567.89);
    expect(resultadoDoOpenCnpj("11222333000181", { ...base, capital_social: "80000.50" }).capitalSocial).toBe(80000.5);
    const r = resultadoDoOpenCnpj("11222333000181", { ...base, telefones: [{ ddd: "66", numero: "35441234", is_fax: true }] });
    expect(r.telefone).toBeNull();
    expect(r).toMatchObject({ fonte: "opencnpj", parcial: true, ies: [], ie: null });
  });
});
