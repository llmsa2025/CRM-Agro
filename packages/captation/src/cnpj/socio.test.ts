import { describe, it, expect } from "vitest";
import {
  compararNome,
  cpfParaExibir,
  cpfValido,
  mascaraDeBusca,
  mascaraValida,
  palavrasDoNome,
  socioDoRegistro,
} from "./socio";
import { FILTROS_LOCAIS_PADRAO, aprovaRegistro, urlDaBusca, type RegistroMinhaReceita } from "./busca";
import { cpfMascaradoDe } from "./fetch";

/** CPFs de teste (válidos pelo dígito verificador, inventados): 529.982.247-25 e 111.444.777-35. */
describe("CPF", () => {
  it("valida os dígitos verificadores", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("11144477735")).toBe(true);
    expect(cpfValido("529.982.247-26")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cpfValido("123")).toBe(false);
    expect(cpfValido("")).toBe(false);
    expect(cpfValido(null)).toBe(false);
  });

  it("a máscara da Receita tem só os 6 dígitos do meio; o CPF inteiro nunca sai", () => {
    expect(mascaraDeBusca("529.982.247-25")).toBe("***982247**");
    expect(mascaraDeBusca("123")).toBeNull();
    expect(mascaraValida("***982247**")).toBe(true);
    expect(mascaraValida("***98224**")).toBe(false);
    expect(mascaraValida("52998224725")).toBe(false);
    expect(cpfMascaradoDe("***982247**")).toBe("***982247**");
    expect(cpfMascaradoDe("12345678000190")).toBeUndefined(); // CNPJ de sócio não é CPF
    expect(cpfParaExibir("***982247**")).toBe("***.982.247-**");
    expect(cpfParaExibir("529.982.247-25")).toBe("***.982.247-**");
    expect(cpfParaExibir("lixo")).toBe("");
    // nada do CPF completo aparece na máscara nem na exibição
    for (const t of [mascaraDeBusca("529.982.247-25")!, cpfParaExibir("529.982.247-25")]) expect(t).not.toContain("529");
  });
});

describe("nome do sócio", () => {
  it("palavras sem acento, caixa e partículas", () => {
    expect(palavrasDoNome("JOSÉ da Silva  e Souza")).toEqual(["jose", "silva", "souza"]);
  });

  it("exato, parcial (mesmo primeiro e último nome) ou nenhum; uma palavra só não identifica ninguém", () => {
    expect(compararNome("Maria Silva", "MARIA SILVA")).toBe("exato");
    expect(compararNome("maria da silva", "Maria Silva")).toBe("exato"); // partícula não conta
    expect(compararNome("Maria Silva", "MARIA APARECIDA SILVA")).toBe("parcial");
    expect(compararNome("Maria Silva", "MARIA APARECIDA SANTOS")).toBeNull();
    expect(compararNome("Maria Silva", "ANA SILVA")).toBeNull();
    expect(compararNome("Maria", "MARIA SILVA")).toBeNull();
    expect(compararNome("Maria Silva", "MARIA")).toBeNull();
    expect(compararNome("João Pedro", "PEDRO JOÃO")).toBeNull(); // ordem importa nas pontas
  });
});

const reg = (qsa: RegistroMinhaReceita["qsa"], extra: Partial<RegistroMinhaReceita> = {}): RegistroMinhaReceita => ({
  cnpj: "11222333000181",
  razao_social: "EMPRESA X",
  situacao_cadastral: 2,
  uf: "MT",
  ...extra,
  qsa,
});
const socios = [
  { nome_socio: "MARIA APARECIDA SILVA", qualificacao_socio: "Sócio-Administrador", cnpj_cpf_do_socio: "***982247**" },
  { nome_socio: "JOSE DE SOUZA", qualificacao_socio: "Sócio", cnpj_cpf_do_socio: "***111222**" },
];

describe("socioDoRegistro (a máscara serve a ~1.000 pessoas: conferir o nome)", () => {
  it("máscara + nome igual = alta; nome contido = média; sem nome = baixa", () => {
    expect(socioDoRegistro(reg(socios), { mascara: "***982247**", nome: "Maria Aparecida Silva" })).toMatchObject({ confianca: "alta", nome: "MARIA APARECIDA SILVA" });
    expect(socioDoRegistro(reg(socios), { mascara: "***982247**", nome: "Maria Silva" })).toMatchObject({ confianca: "media" });
    expect(socioDoRegistro(reg(socios), { mascara: "***982247**", nome: null })).toMatchObject({ confianca: "baixa" });
  });

  it("homônimo de máscara diferente, ou mesma máscara com outro nome: não liga", () => {
    expect(socioDoRegistro(reg(socios), { mascara: "***000000**", nome: "Maria Silva" })).toBeNull();
    expect(socioDoRegistro(reg(socios), { mascara: "***111222**", nome: "Maria Silva" })).toBeNull(); // máscara do José, nome da Maria
    expect(socioDoRegistro(reg([]), { mascara: "***982247**", nome: null })).toBeNull();
    expect(socioDoRegistro(reg(undefined), { mascara: "***982247**", nome: null })).toBeNull();
  });

  it("o filtro de sócio faz parte de aprovaRegistro; a URL leva a máscara (não o CPF)", () => {
    const f = { ...FILTROS_LOCAIS_PADRAO, excluirPessoa: false, socio: { mascara: "***982247**", nome: "Maria Silva" } };
    expect(aprovaRegistro(reg(socios), f)).toBe(true);
    expect(aprovaRegistro(reg([socios[1]!]), f)).toBe(false);
    const u = new URL(urlDaBusca({ cnaes: [], ufs: ["MT"], municipios: [], cnpf: ["***982247**"] }, null));
    expect(u.searchParams.getAll("cnpf")).toEqual(["***982247**"]);
    expect(u.searchParams.getAll("uf")).toEqual(["mt"]);
  });
});
