/**
 * Classificação de PRODUTOR RURAL a partir dos dados de CNPJ (CNAEs + IEs +
 * nomes). Regra determinística (sem IA) versionada — ver
 * a documentação interna §1/§2.
 *
 * Puro: sem I/O, sem Prisma. Recebe o que o `CnpjResult` já traz (agora que o
 * fetch parou de descartar CNAEs secundários e o tipo das IEs) e devolve rótulo +
 * score + evidências + versão da regra (para reprocessar sem ambiguidade).
 */

/** Versão da regra — muda quando os pesos/CNAEs mudam (reprocessamento idempotente). */
export const PRODUTOR_REGRA_VERSAO = "produtor@2026-08-11";

export type ProdutorLabel = "produtor" | "provavel_produtor" | "nao_produtor";

export type ProdutorResult = {
  isProdutor: boolean;
  produtorScore: number; // 0–100 (clamp)
  produtorLabel: ProdutorLabel;
  evidencias: string[];
  regraVersao: string;
};

export type ClassifyProdutorInput = {
  cnaePrincipal?: string | null;
  cnaesSecundarios?: string[]; // códigos (só-dígitos ou formatados)
  ies?: { tipo?: string | null; habilitada?: boolean }[];
  razaoSocial?: string | null;
  nomeFantasia?: string | null;
  nomeSocio?: string | null;
  naturezaJuridica?: string | null;
  /** Agregação por dono: algum OUTRO CNPJ do mesmo sócio tem produção direta. */
  donoTemProducaoDireta?: boolean;
};

type CnaeCategoria =
  | "lavoura_temporaria"
  | "lavoura_permanente"
  | "pecuaria"
  | "horticultura"
  | "sementes_mudas"
  | "florestal_pesca"
  | "apoio_agropecuario"
  | "pos_colheita"
  | "armazem"
  | "atacadista_agricola"
  | "fiacao"
  | "outro";

const CATEGORIA_PESO: Record<CnaeCategoria, number> = {
  lavoura_temporaria: 40,
  lavoura_permanente: 40,
  pecuaria: 40,
  horticultura: 35,
  sementes_mudas: 30,
  florestal_pesca: 30,
  apoio_agropecuario: 10,
  pos_colheita: 10, // ambíguo (algodoeira/beneficiamento)
  armazem: 5, // ambíguo (silos)
  atacadista_agricola: 5,
  fiacao: -10,
  outro: 0,
};

/** Categorias que representam PRODUÇÃO DIRETA (cultiva/cria). */
const PRODUCAO_DIRETA: ReadonlySet<CnaeCategoria> = new Set<CnaeCategoria>([
  "lavoura_temporaria",
  "lavoura_permanente",
  "pecuaria",
  "horticultura",
  "sementes_mudas",
  "florestal_pesca",
]);

/** Categorias AMBÍGUAS (serviço sobre produção alheia) — isoladas → "provável". */
const AMBIGUAS: ReadonlySet<CnaeCategoria> = new Set<CnaeCategoria>([
  "apoio_agropecuario",
  "pos_colheita",
  "armazem",
  "atacadista_agricola",
]);

const KEYWORDS = /fazenda|agropecu|agr[ií]cola|\brural\b|gr[ãa]os|algod[ãa]o|pecu[áa]ria|caf[ée]|s[íi]tio|lavoura/i;

/** Só-dígitos do código; usa os 4 primeiros (classe CNAE). */
function prefixo4(codigo: string): string {
  return codigo.replace(/\D/g, "").slice(0, 4);
}

/** Classifica um CNAE (código) numa categoria com peso. Ver tabela do doc §1. */
export function classificaCnae(codigo: string): CnaeCategoria {
  const p = prefixo4(codigo);
  if (!p) return "outro";
  const n = Number(p);
  // Lavoura temporária 0111–0119
  if (n >= 111 && n <= 119) return "lavoura_temporaria";
  // Horticultura/floricultura 0121–0122
  if (n === 121 || n === 122) return "horticultura";
  // Lavoura permanente 0131–0134
  if (n >= 131 && n <= 134) return "lavoura_permanente";
  // Sementes/mudas 0141–0142
  if (n === 141 || n === 142) return "sementes_mudas";
  // Pecuária 0151–0159
  if (n >= 151 && n <= 159) return "pecuaria";
  // Pós-colheita / algodoeira 0163
  if (n === 163) return "pos_colheita";
  // Apoio agropecuário 0161/0162
  if (n === 161 || n === 162) return "apoio_agropecuario";
  // Produção florestal 0210/0220
  if (n === 210 || n === 220) return "florestal_pesca";
  // Pesca-aquicultura 03xx (0311–0322)
  if (p.startsWith("03")) return "florestal_pesca";
  // Armazém geral / silos 5211
  if (n === 5211) return "armazem";
  // Atacadista agrícola 4623
  if (n === 4623) return "atacadista_agricola";
  // Fiação de algodão (indústria) 1311
  if (n === 1311) return "fiacao";
  return "outro";
}

/** IE de PRODUTOR RURAL? (o tipo mais forte — Sintegra, atrelada ao imóvel). */
function ieProdutor(tipo?: string | null): boolean {
  return !!tipo && /produtor\s*rural|produtor/i.test(tipo);
}

/**
 * Classifica o CNPJ como produtor rural (regra §2). Score 0–100 + rótulo de 3
 * estados + evidências (o "por quê" auditável) + versão da regra.
 */
export function classificarProdutor(input: ClassifyProdutorInput): ProdutorResult {
  const evidencias: string[] = [];
  let score = 0;

  const codigos = [input.cnaePrincipal, ...(input.cnaesSecundarios ?? [])].filter(
    (c): c is string => !!c && !!c.replace(/\D/g, ""),
  );
  const categorias = codigos.map((c) => ({ codigo: c, cat: classificaCnae(c) }));

  // Soma o peso de cada CNAE (principal + secundários). Só registra evidência dos
  // que empurram (peso != 0).
  for (const { codigo, cat } of categorias) {
    const peso = CATEGORIA_PESO[cat];
    if (peso !== 0) {
      score += peso;
      evidencias.push(`CNAE ${prefixo4(codigo)} (${cat}) ${peso > 0 ? "+" : ""}${peso}`);
    }
  }

  const producaoDireta = categorias.some((c) => PRODUCAO_DIRETA.has(c.cat));
  const soAmbiguas =
    categorias.length > 0 && categorias.every((c) => AMBIGUAS.has(c.cat)) && !producaoDireta;

  // IE: tipo "produtor rural" é o sinal mais forte (+45); senão IE habilitada (+8).
  const ies = input.ies ?? [];
  let flagIeProdutor = false;
  if (ies.some((i) => ieProdutor(i.tipo))) {
    score += 45;
    flagIeProdutor = true;
    evidencias.push("IE de produtor rural +45");
  } else if (ies.some((i) => i.habilitada)) {
    score += 8;
    evidencias.push("IE habilitada +8");
  }

  // Palavras-chave em razão/fantasia/sócio (+12).
  const texto = [input.razaoSocial, input.nomeFantasia, input.nomeSocio].filter(Boolean).join(" ");
  if (texto && KEYWORDS.test(texto)) {
    score += 12;
    evidencias.push("palavra-chave do agro +12");
  }

  // Natureza jurídica coerente (produtor PF / empresário individual) (+8).
  if (input.naturezaJuridica && /empres[áa]rio\s*individual|produtor/i.test(input.naturezaJuridica)) {
    score += 8;
    evidencias.push("natureza jurídica coerente +8");
  }

  // Agregação por dono: outro CNPJ do mesmo sócio produz (+20).
  let flagDonoProdutor = false;
  if (input.donoTemProducaoDireta) {
    score += 20;
    flagDonoProdutor = true;
    evidencias.push("dono tem CNPJ com produção direta +20");
  }

  // Clamp 0–100.
  const produtorScore = Math.max(0, Math.min(100, score));

  // Decisão (doc §2): produção direta + (IE-produtor OU score alto) = produtor;
  // só ambíguas e sem dono-produtor = provável; senão pela faixa de score.
  let produtorLabel: ProdutorLabel;
  if (producaoDireta && (flagIeProdutor || produtorScore >= 55)) {
    produtorLabel = "produtor";
  } else if (soAmbiguas && !flagDonoProdutor) {
    produtorLabel = "provavel_produtor";
  } else if (produtorScore >= 55) {
    produtorLabel = "produtor";
  } else if (produtorScore >= 30) {
    produtorLabel = "provavel_produtor";
  } else {
    produtorLabel = "nao_produtor";
  }

  return {
    isProdutor: produtorLabel === "produtor",
    produtorScore,
    produtorLabel,
    evidencias,
    regraVersao: PRODUTOR_REGRA_VERSAO,
  };
}
