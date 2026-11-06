import Papa from "papaparse";
import { normalizePhone } from "../contacts/phone";
import { normalizeCnpj, normalizeCpf, normalizeEmail } from "../normalize/index";
import { CAMPOS_IMPORTACAO, type CampoImportacao, type Mapeamento } from "./schema";
import { MapeamentoInvalido, PlanilhaGrandeDemais, PlanilhaVazia } from "./errors";

/**
 * Leitura da planilha da importação (produto §C) — funções PURAS, sem banco:
 * a prévia (web) e o worker usam as mesmas, então a tela mostra exatamente o
 * que a importação vai fazer.
 *
 * Entrada: texto CSV (a borda converte Excel para CSV). Separador detectado
 * sozinho (`,` `;` tab — o Excel em português salva com `;`).
 */

/** Teto de linhas de dados por importação. */
export const LIMITE_LINHAS = 50_000;
/** Teto de colunas (o mapeamento tem um item por coluna). */
export const LIMITE_COLUNAS = 200;

/** Linha de dados com o número dela na planilha (cabeçalho = linha 1, como no Excel). */
export type LinhaPlanilha = { linha: number; celulas: string[] };
export type Planilha = { colunas: string[]; linhas: LinhaPlanilha[] };

export function lerPlanilha(texto: string): Planilha {
  const semBom = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  // Sem pular linha vazia no parser: a numeração tem de bater com a do Excel.
  const { data } = Papa.parse<string[]>(semBom, { skipEmptyLines: false });
  const cabecalho = data[0];
  if (!cabecalho || cabecalho.every((c) => !c.trim())) throw new PlanilhaVazia();
  if (cabecalho.length > LIMITE_COLUNAS) throw new PlanilhaGrandeDemais(`até ${LIMITE_COLUNAS} colunas`);
  const linhas: LinhaPlanilha[] = [];
  for (let i = 1; i < data.length; i++) {
    const celulas = data[i]!.map((c) => (c ?? "").trim());
    if (celulas.every((c) => !c)) continue;
    linhas.push({ linha: i + 1, celulas });
    if (linhas.length > LIMITE_LINHAS) throw new PlanilhaGrandeDemais("até 50.000 linhas");
  }
  if (linhas.length === 0) throw new PlanilhaVazia();
  return { colunas: cabecalho.map((c, i) => c.trim() || `Coluna ${i + 1}`), linhas };
}

// ────────────────────────────────────────────────────────────────────────────
// Mapeamento sugerido pelo nome da coluna
// ────────────────────────────────────────────────────────────────────────────

const SINONIMOS: Record<CampoImportacao, string[]> = {
  nome: ["nome", "nome completo", "name", "full name", "produtor", "cliente", "responsavel", "lead"],
  sobrenome: ["sobrenome", "ultimo nome", "last name", "lastname", "surname"],
  cpf: ["cpf", "cpf do contato", "cpf titular"],
  documento: ["cpf cnpj", "cnpj cpf", "cpf ou cnpj", "cnpj ou cpf", "cpf e cnpj", "documento", "doc"],
  cnpj: ["cnpj", "cnpj da empresa"],
  ie: ["ie", "inscricao estadual", "insc estadual", "inscricao estadual ie", "i e"],
  whatsapp: ["whatsapp", "whats", "zap", "celular", "telefone", "telefone celular", "fone", "phone", "tel", "mobile"],
  whatsapp2: ["telefone 2", "telefone2", "celular 2", "celular2", "whatsapp 2", "whatsapp2", "fone 2", "tel 2", "telefone secundario", "telefone adicional"],
  email: ["email", "e mail", "mail", "correio eletronico"],
  email2: ["email 2", "email2", "e mail 2", "email secundario", "segundo email", "email adicional"],
  empresa: ["empresa", "fazenda", "propriedade", "company", "organizacao", "razao social", "nome fantasia"],
  cidade: ["cidade", "municipio", "city"],
  estado: ["uf", "estado", "state"],
  cargo: ["cargo", "funcao", "profissao", "position", "job title"],
  origem: ["origem", "fonte", "source"],
  tags: ["tags", "tag", "cultura", "culturas", "etiqueta", "etiquetas", "segmento"],
};
/**
 * Ordem da busca "contém a palavra" (2ª passada): o mais específico primeiro —
 * "Nome da fazenda" é empresa, "Telefone (WhatsApp)" é WhatsApp.
 */
const PRIORIDADE: CampoImportacao[] = ["documento", "email2", "email", "whatsapp2", "whatsapp", "cnpj", "cpf", "ie", "empresa", "sobrenome", "nome", "cidade", "estado", "cargo", "origem", "tags"];

/** "Município (MT)" → "municipio mt": sem acento, minúsculo, só letras/dígitos. */
function chaveDeColuna(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Sugestão por nome de coluna. Campo único vai para a 1ª coluna que casar; `tags` pode repetir. */
export function sugerirMapeamento(colunas: readonly string[]): Mapeamento {
  const chaves = colunas.map(chaveDeColuna);
  const mapa: Mapeamento = colunas.map(() => null);
  const usado = new Set<CampoImportacao>();
  const atribuir = (i: number, campo: CampoImportacao) => {
    if (mapa[i] !== null || (campo !== "tags" && usado.has(campo))) return;
    mapa[i] = campo;
    usado.add(campo);
  };
  // 1ª passada: nome da coluna igual a um sinônimo.
  chaves.forEach((k, i) => {
    const campo = CAMPOS_IMPORTACAO.find((c) => SINONIMOS[c].includes(k));
    if (campo) atribuir(i, campo);
  });
  // 2ª passada: o sinônimo aparece como palavra inteira no nome da coluna.
  chaves.forEach((k, i) => {
    if (mapa[i] !== null) return;
    const palavras = ` ${k} `;
    const campo = PRIORIDADE.find((c) => SINONIMOS[c].some((s) => palavras.includes(` ${s} `)));
    if (campo) atribuir(i, campo);
  });
  return mapa;
}

/** Tamanho igual ao das colunas; campo único (tudo menos `tags`) no máximo uma vez. */
export function validarMapeamento(colunas: readonly string[], mapeamento: Mapeamento): void {
  if (mapeamento.length !== colunas.length) {
    throw new MapeamentoInvalido(`são ${colunas.length} colunas e o mapeamento tem ${mapeamento.length} itens`);
  }
  const vistos = new Set<CampoImportacao>();
  for (const campo of mapeamento) {
    if (!campo || campo === "tags") continue;
    if (vistos.has(campo)) throw new MapeamentoInvalido(`o campo "${campo}" está em mais de uma coluna`);
    vistos.add(campo);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Linhas → registros (validação e união dos repetidos)
// ────────────────────────────────────────────────────────────────────────────

/** Uma empresa da linha (uma por CNPJ ou IE), com a cidade e o estado dela. */
export type EmpresaDaLinha = { nome?: string; cnpj?: string; ie?: string; cidade?: string; estado?: string };

/** Um contato a importar (já normalizado), com as linhas repetidas unidas a ele. */
export type Registro = {
  linha: number;
  nome: string;
  sobrenome?: string;
  empresa?: string;
  cidade?: string;
  estado?: string;
  cargo?: string;
  origem?: string;
  tags: string[];
  /** Só dígitos (11), já conferido. */
  cpf?: string;
  /** Todos os WhatsApp/telefones da pessoa em E.164; o primeiro é o principal. */
  whatsapps: string[];
  /** Todos os e-mails, em minúsculo; o primeiro é o principal. */
  emails: string[];
  /** O principal de `whatsapps` (E.164). */
  whatsapp?: string;
  /** O principal de `emails`. */
  email?: string;
  /** Empresas da pessoa (uma por CNPJ ou IE). Linha só com o nome da empresa continua em `empresa`. */
  empresas: EmpresaDaLinha[];
  /** Linhas repetidas (mesmo CPF, WhatsApp ou e-mail) unidas a esta. */
  unidas: number[];
};

export type LinhaRecusada = { linha: number; motivo: string };
export type LinhaRepetida = { linha: number; de: number };
export type Registros = { registros: Registro[]; invalidas: LinhaRecusada[]; repetidas: LinhaRepetida[] };

const CAMPOS_DE_TEXTO = ["sobrenome", "empresa", "cidade", "estado", "cargo", "origem"] as const;
const MAX_EMPRESAS_POR_CONTATO = 20;

/**
 * CPF (11 dígitos) ou CNPJ (14) pelos dígitos, conferindo os verificadores, venha na coluna que vier (no agro
 * a mesma lista mistura os dois). Devolve os zeros que o Excel comeu (até 3). Nulo se não for nenhum dos dois.
 */
function classificarDocumento(bruto: string): { tipo: "cpf" | "cnpj"; digitos: string } | null {
  const d = bruto.replace(/\D/g, "");
  if (d.length >= 8 && d.length <= 11) {
    const cpf = normalizeCpf(d.padStart(11, "0")).canonical;
    if (cpf) return { tipo: "cpf", digitos: cpf };
  }
  if (d.length >= 11 && d.length <= 14) {
    const cnpj = normalizeCnpj(d.padStart(14, "0")).canonical;
    if (cnpj) return { tipo: "cnpj", digitos: cnpj };
  }
  return null;
}

/** Colunas que carregam documento, com o rótulo usado no motivo da linha recusada. */
const COLUNAS_DE_DOCUMENTO = [
  ["cpf", "CPF"],
  ["cnpj", "CNPJ"],
  ["documento", "CPF ou CNPJ"],
] as const;

/** Tags de uma célula: "soja, milho; algodão" → 3 tags (sem repetir, ignorando caixa). */
function tagsDe(valores: string[]): string[] {
  const out = new Map<string, string>();
  for (const v of valores) {
    for (const t of v.split(/[,;|]/)) {
      const tag = t.trim();
      if (tag && !out.has(tag.toLowerCase())) out.set(tag.toLowerCase(), tag);
    }
  }
  return [...out.values()];
}

/**
 * Valida cada linha e une as repetidas. Regras (as mesmas da prévia e do worker):
 *   - sem nome → recusada ("Sem nome");
 *   - WhatsApp preenchido que não vira E.164 → recusada ("Telefone inválido");
 *   - e-mail preenchido inválido → recusada ("E-mail inválido");
 *   - CPF ou CNPJ preenchido que não passa nos dígitos verificadores → recusada ("CPF inválido" / "CNPJ inválido");
 *   - mesmo CPF, WhatsApp ou e-mail de uma linha anterior → REPETIDA: unida à 1ª (completa os campos vazios,
 *     soma as tags, os telefones, os e-mails e as empresas: uma por CNPJ ou IE).
 */
export function montarRegistros(planilha: Planilha, mapeamento: Mapeamento): Registros {
  validarMapeamento(planilha.colunas, mapeamento);
  const colunasDe = (campo: CampoImportacao) =>
    mapeamento.flatMap((c, i) => (c === campo ? [i] : []));
  const indice = Object.fromEntries(CAMPOS_IMPORTACAO.map((c) => [c, colunasDe(c)])) as Record<CampoImportacao, number[]>;

  const registros: Registro[] = [];
  const invalidas: LinhaRecusada[] = [];
  const repetidas: LinhaRepetida[] = [];
  const donoDaChave = new Map<string, Registro>();

  for (const { linha, celulas } of planilha.linhas) {
    const valor = (campo: CampoImportacao) => indice[campo].map((i) => celulas[i] ?? "").find((v) => v) ?? "";
    const nome = valor("nome");
    if (!nome) {
      invalidas.push({ linha, motivo: "Sem nome" });
      continue;
    }
    const telBruto = valor("whatsapp");
    const whatsapp = telBruto ? normalizePhone(telBruto) : null;
    if (telBruto && !whatsapp) {
      invalidas.push({ linha, motivo: "Telefone inválido" });
      continue;
    }
    const emailBruto = valor("email");
    const email = emailBruto ? normalizeEmail(emailBruto).canonical : null;
    if (emailBruto && !email) {
      invalidas.push({ linha, motivo: "E-mail inválido" });
      continue;
    }
    let cpf: string | undefined;
    let cnpj: string | undefined;
    let documentoRuim = "";
    for (const [campo, rotulo] of COLUNAS_DE_DOCUMENTO) {
      const bruto = valor(campo);
      if (!bruto) continue;
      const doc = classificarDocumento(bruto);
      if (!doc) {
        documentoRuim = `${rotulo} inválido`;
        break;
      }
      if (doc.tipo === "cpf") cpf ??= doc.digitos;
      else cnpj ??= doc.digitos;
    }
    if (documentoRuim) {
      invalidas.push({ linha, motivo: documentoRuim });
      continue;
    }
    const estado = valor("estado");
    if (estado.length > 40) {
      invalidas.push({ linha, motivo: "Estado inválido" });
      continue;
    }

    // Segundo telefone e segundo e-mail são extras: se não valem, a linha segue sem eles.
    const tel2Bruto = valor("whatsapp2");
    const email2Bruto = valor("email2");
    const whatsapps = [...new Set([whatsapp, tel2Bruto ? normalizePhone(tel2Bruto) : null].filter((v): v is string => !!v))];
    const emails = [...new Set([email, email2Bruto ? normalizeEmail(email2Bruto).canonical : null].filter((v): v is string => !!v))];

    const reg: Registro = { linha, nome, tags: tagsDe(indice.tags.map((i) => celulas[i] ?? "")), unidas: [], whatsapps, emails, empresas: [] };
    for (const campo of CAMPOS_DE_TEXTO) {
      const v = valor(campo);
      if (v) reg[campo] = v;
    }
    if (whatsapps[0]) reg.whatsapp = whatsapps[0];
    if (emails[0]) reg.email = emails[0];
    if (cpf) reg.cpf = cpf;
    const ie = valor("ie");
    if (cnpj || ie) reg.empresas.push({ nome: reg.empresa, cnpj, ie: ie || undefined, cidade: reg.cidade, estado: reg.estado });

    const chaves = [cpf && `c:${cpf}`, ...whatsapps.map((w) => `w:${w}`), ...emails.map((e) => `e:${e}`)].filter((k): k is string => !!k);
    const primeiro = chaves.map((k) => donoDaChave.get(k)).find((r) => r);
    if (primeiro) {
      unir(primeiro, reg, donoDaChave);
      repetidas.push({ linha, de: primeiro.linha });
      continue;
    }
    registros.push(reg);
    for (const k of chaves) donoDaChave.set(k, reg);
  }
  return { registros, invalidas, repetidas };
}

/** Soma a empresa ao contato: a mesma (CNPJ, ou IE sem CNPJ) só completa o que faltava; outra é acrescentada. */
function juntarEmpresa(alvo: Registro, nova: EmpresaDaLinha): void {
  const igual = alvo.empresas.find((e) => (nova.cnpj && e.cnpj === nova.cnpj) || (nova.ie && e.ie === nova.ie && (!nova.cnpj || !e.cnpj)));
  if (!igual) {
    if (alvo.empresas.length < MAX_EMPRESAS_POR_CONTATO) alvo.empresas.push(nova);
    return;
  }
  for (const campo of ["nome", "cnpj", "ie", "cidade", "estado"] as const) if (!igual[campo] && nova[campo]) igual[campo] = nova[campo];
}

/**
 * Une a linha repetida `r` ao registro `alvo` (só completa; nunca troca o que já tem). Telefones, e-mails e
 * empresas se somam, desde que o telefone/e-mail/CPF não seja de OUTRO registro da planilha.
 */
function unir(alvo: Registro, r: Registro, donoDaChave: Map<string, Registro>): void {
  for (const campo of CAMPOS_DE_TEXTO) if (!alvo[campo] && r[campo]) alvo[campo] = r[campo];
  alvo.tags = tagsDe([...alvo.tags, ...r.tags]);
  if (!alvo.cpf && r.cpf && !donoDaChave.has(`c:${r.cpf}`)) {
    alvo.cpf = r.cpf;
    donoDaChave.set(`c:${r.cpf}`, alvo);
  }
  for (const w of r.whatsapps) {
    if (alvo.whatsapps.includes(w) || donoDaChave.has(`w:${w}`)) continue;
    alvo.whatsapps.push(w);
    donoDaChave.set(`w:${w}`, alvo);
  }
  for (const e of r.emails) {
    if (alvo.emails.includes(e) || donoDaChave.has(`e:${e}`)) continue;
    alvo.emails.push(e);
    donoDaChave.set(`e:${e}`, alvo);
  }
  alvo.whatsapp = alvo.whatsapps[0];
  alvo.email = alvo.emails[0];
  for (const e of r.empresas) juntarEmpresa(alvo, e);
  alvo.unidas.push(r.linha);
}
