import { CnpjLookupFailed } from "./errors";
import { socioDoRegistro, type AlvoDeSocio } from "./socio";
import { cpfMascaradoDe, fmtPhone, type CnaeItem, type CnpjResult, type SocioItem } from "./fetch";

/**
 * Busca de empresas POR FILTRO (CNAE, UF, município) na Minha Receita
 * (minhareceita.org, projeto voluntário sobre os dados abertos da Receita Federal).
 *
 * O que a fonte entrega: dados cadastrais, sócios (CPF mascarado) e telefone. O
 * e-mail não vem nesta fonte: quem quiser o
 * e-mail completa depois pela consulta de CNPJ (`consultarCnpj` do core).
 *
 * Só os filtros CNAE, UF e município são feitos pela fonte. Situação, tipo de
 * empresa (empresário individual e MEI), porte, capital social e data de abertura
 * são feitos AQUI, depois de ler cada página (`aprovaRegistro`): a fonte não os
 * aceita. Por isso uma busca lê mais do que devolve.
 *
 * Fonte sem garantia de serviço: ritmo baixo (quem chama pausa entre páginas),
 * tempo máximo por pedido e uma nova tentativa só em erro 5xx.
 * Documentação: https://docs.minhareceita.org/como-usar/
 */

export const MINHA_RECEITA_URL = "https://minhareceita.org/";
/** Registros por página pedidos à fonte (o máximo dela é 1.024; ficamos baixo para ser gentil). */
export const MINHA_RECEITA_POR_PAGINA = 100;
/** Tempo máximo de cada pedido: a busca paginada é mais lenta que a consulta de um CNPJ. */
export const MINHA_RECEITA_TIMEOUT_MS = 30_000;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Natureza jurídica "Empresário (Individual)": é uma pessoa, com o próprio nome e telefone. */
export const NATUREZA_EMPRESARIO_INDIVIDUAL = 2135;

export type PorteEmpresa = "micro" | "pequeno" | "demais";

/** Filtros que a FONTE entende. Valores já limpos (só dígitos nos CNAEs, UF em maiúsculas). */
export type FiltrosDaFonte = {
  /** CNAE (7 dígitos) principal OU secundário. */
  cnaes: string[];
  ufs: string[];
  /** Código IBGE do município. */
  municipios: number[];
  /** CPF de sócio MASCARADO ("***456789**"): empresas em que um sócio tem essa máscara. */
  cnpf?: string[];
};

/** Filtros que o CRM Agro aplica depois de ler cada registro. */
export type FiltrosLocais = {
  soAtivas: boolean;
  /** Tira empresário individual e MEI (pessoa física com CNPJ). */
  excluirPessoa: boolean;
  portes: PorteEmpresa[];
  capitalMin: number | null;
  capitalMax: number | null;
  /** AAAA-MM-DD */
  abertaDesde: string | null;
  abertaAte: string | null;
  /** Só empresas com telefone válido (DDD + número) cadastrado na Receita. */
  soComTelefone: boolean;
  /**
   * CNAEs (7 dígitos) que o CNAE PRINCIPAL da empresa precisa ser um deles. A fonte devolve a empresa
   * quando o CNAE é principal OU secundário; com esta lista preenchida só fica quem tem o principal. Vazio ou
   * ausente = aceita os secundários também.
   */
  cnaesPrincipais?: string[];
  /** Busca por sócio: só passa a empresa que tem esse sócio (máscara do CPF e, se houver, nome compatível). */
  socio?: AlvoDeSocio | null;
};

export const FILTROS_LOCAIS_PADRAO: FiltrosLocais = {
  soAtivas: true,
  excluirPessoa: true,
  portes: [],
  capitalMin: null,
  capitalMax: null,
  abertaDesde: null,
  abertaAte: null,
  soComTelefone: false,
};

/** O que lemos de cada registro da Minha Receita (o resto da resposta é ignorado). */
export type RegistroMinhaReceita = {
  cnpj?: string;
  razao_social?: string | null;
  nome_fantasia?: string | null;
  situacao_cadastral?: number | null;
  descricao_situacao_cadastral?: string | null;
  data_inicio_atividade?: string | null;
  cnae_fiscal?: number | string | null;
  cnae_fiscal_descricao?: string | null;
  cnaes_secundarios?: { codigo?: number | string; descricao?: string | null }[] | null;
  descricao_tipo_de_logradouro?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  uf?: string | null;
  ddd_telefone_1?: string | null;
  ddd_telefone_2?: string | null;
  email?: string | null;
  porte?: string | null;
  capital_social?: number | string | null;
  codigo_natureza_juridica?: number | string | null;
  opcao_pelo_mei?: boolean | null;
  qsa?: { nome_socio?: string | null; qualificacao_socio?: string | null; cnpj_cpf_do_socio?: string | null; faixa_etaria?: string | null }[] | null;
};

const soDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const texto = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/** Porte da Receita ("MICRO EMPRESA", "EMPRESA DE PEQUENO PORTE", "DEMAIS") → nossa sigla. */
export function porteDoRegistro(porte: string | null | undefined): PorteEmpresa | null {
  const p = (porte ?? "").toUpperCase();
  if (p.includes("MICRO")) return "micro";
  if (p.includes("PEQUENO")) return "pequeno";
  if (p.includes("DEMAIS")) return "demais";
  return null;
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Telefone da Receita com DDD: 10 dígitos (fixo) ou 11 (celular). "0", lixo e número cortado não valem. */
export function telefoneValido(v: unknown): boolean {
  const d = soDigitos(v);
  return (d.length === 10 || d.length === 11) && !/^(\d)\1+$/.test(d);
}

/** A empresa é, na prática, uma pessoa (empresário individual ou MEI)? */
export function ehPessoaFisica(r: RegistroMinhaReceita): boolean {
  return Number(r.codigo_natureza_juridica) === NATUREZA_EMPRESARIO_INDIVIDUAL || r.opcao_pelo_mei === true;
}

/** A empresa está com a situação cadastral ATIVA na Receita (código 2 ou descrição "ATIVA")? Baixada, inapta, suspensa e nula não. */
export function registroAtivo(r: Pick<RegistroMinhaReceita, "situacao_cadastral" | "descricao_situacao_cadastral">): boolean {
  return Number(r.situacao_cadastral) === 2 || (r.descricao_situacao_cadastral ?? "").trim().toUpperCase() === "ATIVA";
}

/**
 * O registro passa nos filtros locais? Função pura. Sem dado para decidir (porte
 * ou capital ausentes) a empresa NÃO passa quando o filtro correspondente está
 * ligado: melhor deixar de fora do que mostrar o que o usuário pediu para excluir.
 */
export function aprovaRegistro(r: RegistroMinhaReceita, f: FiltrosLocais): boolean {
  if (f.soAtivas && !registroAtivo(r)) return false;
  if (f.excluirPessoa && ehPessoaFisica(r)) return false;
  if (f.portes.length) {
    const p = porteDoRegistro(r.porte);
    if (!p || !f.portes.includes(p)) return false;
  }
  if (f.capitalMin !== null || f.capitalMax !== null) {
    const capital = numero(r.capital_social);
    if (capital === null) return false;
    if (f.capitalMin !== null && capital < f.capitalMin) return false;
    if (f.capitalMax !== null && capital > f.capitalMax) return false;
  }
  if (f.abertaDesde || f.abertaAte) {
    const d = texto(r.data_inicio_atividade);
    if (!d) return false;
    if (f.abertaDesde && d < f.abertaDesde) return false;
    if (f.abertaAte && d > f.abertaAte) return false;
  }
  if (f.soComTelefone && !telefoneValido(r.ddd_telefone_1) && !telefoneValido(r.ddd_telefone_2)) return false;
  if (f.cnaesPrincipais?.length && !f.cnaesPrincipais.includes(cnae7(r.cnae_fiscal))) return false;
  if (f.socio && !socioDoRegistro(r, f.socio)) return false;
  return true;
}

const cnae7 = (v: unknown) => soDigitos(v).padStart(7, "0");

/** Registro da Minha Receita → o mesmo formato da consulta de CNPJ (vira rascunho como os demais). */
export function resultadoDoRegistro(r: RegistroMinhaReceita): CnpjResult | null {
  const cnpj = soDigitos(r.cnpj);
  if (cnpj.length !== 14) return null;
  const razao = texto(r.razao_social);
  const fantasia = texto(r.nome_fantasia);
  const socios: SocioItem[] = (r.qsa ?? [])
    .filter((q) => texto(q?.nome_socio))
    .map((q) => ({
      nome: String(q.nome_socio).trim(),
      qualificacao: texto(q?.qualificacao_socio),
      ...(cpfMascaradoDe(q?.cnpj_cpf_do_socio) ? { cpfMascarado: cpfMascaradoDe(q?.cnpj_cpf_do_socio) } : {}),
      ...(texto(q?.faixa_etaria) ? { faixaEtaria: texto(q?.faixa_etaria)! } : {}),
    }));
  const socio = socios[0]?.nome ?? null;
  const cnaesSecundarios: CnaeItem[] = (r.cnaes_secundarios ?? [])
    .filter((c) => c?.codigo != null)
    .map((c) => ({ codigo: cnae7(c.codigo), descricao: texto(c.descricao) }));
  const endereco = [
    [texto(r.descricao_tipo_de_logradouro), texto(r.logradouro)].filter(Boolean).join(" "),
    texto(r.numero),
    texto(r.bairro),
  ]
    .filter(Boolean)
    .join(", ");
  const tel = soDigitos(r.ddd_telefone_1) || soDigitos(r.ddd_telefone_2);
  const email = texto(r.email);
  return {
    cnpj,
    razaoSocial: razao,
    nomeFantasia: fantasia,
    nomeSocio: socio,
    ie: null,
    nome: socio || fantasia || razao || cnpj,
    situacao: texto(r.descricao_situacao_cadastral),
    cnae: r.cnae_fiscal != null ? cnae7(r.cnae_fiscal) : null,
    cnaeDescricao: texto(r.cnae_fiscal_descricao),
    cnaesSecundarios,
    ies: [],
    cidade: texto(r.municipio),
    uf: texto(r.uf),
    endereco: endereco || null,
    telefone: tel ? fmtPhone(tel) : null,
    email: email ? email.toLowerCase() : null,
    naturezaJuridica: texto((r as { natureza_juridica?: string | null }).natureza_juridica),
    consultadoEm: new Date().toISOString(),
    dataAbertura: texto(r.data_inicio_atividade),
    fonte: "minhareceita",
    parcial: true,
    socios,
    porte: texto(r.porte),
    capitalSocial: numero(r.capital_social),
  };
}

export type PaginaDeBusca = {
  registros: RegistroMinhaReceita[];
  /** Valor opaco para pedir a próxima página; null = foi a última. */
  cursor: string | null;
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Monta a URL da busca. Valores repetidos viram parâmetros repetidos (a fonte aceita as duas formas). */
export function urlDaBusca(f: FiltrosDaFonte, cursor: string | null, limite = MINHA_RECEITA_POR_PAGINA): string {
  const p = new URLSearchParams();
  for (const c of f.cnaes) p.append("cnae", c);
  for (const u of f.ufs) p.append("uf", u.toLowerCase());
  for (const m of f.municipios) p.append("municipio", String(m));
  for (const c of f.cnpf ?? []) p.append("cnpf", c);
  p.set("limit", String(Math.min(Math.max(Math.floor(limite), 1), 1024)));
  if (cursor) p.set("cursor", cursor);
  return `${MINHA_RECEITA_URL}?${p.toString()}`;
}

/**
 * Lê UMA página da busca. Erro de rede, tempo esgotado e resposta que não é JSON
 * viram `CnpjLookupFailed`; 5xx tem uma segunda tentativa com espera.
 */
export async function buscarPaginaMinhaReceita(
  f: FiltrosDaFonte,
  cursor: string | null,
  opts: { limite?: number } = {},
): Promise<PaginaDeBusca> {
  if (!f.cnaes.length && !f.ufs.length && !f.municipios.length && !(f.cnpf ?? []).length) {
    // Sem nenhum filtro a fonte redireciona para a documentação: nem pedimos.
    throw new CnpjLookupFailed("busca", "informe ao menos um filtro (CNAE, estado ou cidade)");
  }
  const url = urlDaBusca(f, cursor, opts.limite);
  for (let tentativa = 1; ; tentativa++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(MINHA_RECEITA_TIMEOUT_MS),
      });
    } catch (e) {
      const tempo = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new CnpjLookupFailed("busca", tempo ? `tempo esgotado (${MINHA_RECEITA_TIMEOUT_MS / 1000}s)` : `erro de rede: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 500 && tentativa === 1) {
      await esperar(1_500 + Math.random() * 500);
      continue;
    }
    if (!res.ok) throw new CnpjLookupFailed("busca", `HTTP ${res.status}`);
    let corpo: { data?: unknown; cursor?: unknown };
    try {
      corpo = (await res.json()) as { data?: unknown; cursor?: unknown };
    } catch {
      throw new CnpjLookupFailed("busca", "a fonte respondeu algo que não é JSON");
    }
    const registros = Array.isArray(corpo.data) ? (corpo.data as RegistroMinhaReceita[]) : [];
    const prox = corpo.cursor === null || corpo.cursor === undefined || corpo.cursor === "" ? null : String(corpo.cursor);
    return { registros, cursor: prox };
  }
}
