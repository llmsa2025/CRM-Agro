/**
 * Regras PURAS de e-mail da busca de empresas por filtro (captação por CNAE).
 *
 * A fonte da busca (Minha Receita) NÃO traz e-mail. Estas regras só valem para o que
 * aparece depois que a empresa é consultada pelo CNPJ (OpenCNPJ, CNPJá, BrasilAPI), ou
 * seja, quando a opção de buscar o e-mail de cada empresa está ligada.
 */

/**
 * Indício de e-mail de ESCRITÓRIO DE CONTABILIDADE (decisão do dono, 06/10/2026). Comparação sem
 * diferença de maiúscula e sem acento, no e-mail inteiro (antes e depois do @).
 *
 * - `CONTABILIDADE_EM_QUALQUER_LUGAR`: o pedaço casa em qualquer posição ("contabilidade@",
 *   "contabil@", "x@contabilizei.com.br").
 * - `CONTABILIDADE_PALAVRA_INTEIRA`: o termo só casa como palavra INTEIRA, delimitada por início, fim ou
 *   um destes: `. - _ @`. Por isso "cont@x.com", "cont.sul@x.com.br" e "a@cont.com.br" casam, mas
 *   "contato@", "contrato@", "controle@" e "continental@" NÃO (senão sairiam quase todas as empresas
 *   com "contato@"). Para ampliar, acrescente o termo na lista certa.
 */
export const CONTABILIDADE_EM_QUALQUER_LUGAR: readonly string[] = ["contab"];
export const CONTABILIDADE_PALAVRA_INTEIRA: readonly string[] = ["cont"];

/** Minúsculas e sem acento (NFD sem as marcas). */
export function semAcento(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const escaparRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function regexPalavraInteira(termos: readonly string[]): RegExp | null {
  if (!termos.length) return null;
  return new RegExp(`(^|[.\\-_@])(${termos.map((t) => escaparRegex(semAcento(t))).join("|")})($|[.\\-_@])`);
}

/** O e-mail tem indício de contabilidade (antes ou depois do @)? */
export function emailDeContabilidade(email: string | null | undefined): boolean {
  if (!email) return false;
  const n = semAcento(email.trim());
  if (CONTABILIDADE_EM_QUALQUER_LUGAR.some((t) => n.includes(semAcento(t)))) return true;
  return regexPalavraInteira(CONTABILIDADE_PALAVRA_INTEIRA)?.test(n) ?? false;
}

/** E-mail com cara de e-mail: algo@dominio.tld, sem espaço. */
export function emailValido(email: string | null | undefined): boolean {
  return !!email && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim());
}

/** A parte depois do @ (o domínio), sem acento e em minúsculas. Vazio se não houver @. */
export function dominioDoEmail(email: string): string {
  const i = email.lastIndexOf("@");
  return i < 0 ? "" : semAcento(email.slice(i + 1).trim());
}

/**
 * Texto que a pessoa digitou ("grupo", "@grupo", "grupo, agro") → palavras limpas: sem @, sem acento, em
 * minúsculas, sem repetição. Vírgula, ponto e vírgula ou quebra de linha separam (são "OU").
 */
export function palavrasDoDominio(texto: string | null | undefined): string[] {
  const palavras: string[] = [];
  for (const parte of (texto ?? "").split(/[,;\n]+/)) {
    const p = semAcento(parte.trim().replace(/^@+/, "").trim());
    if (p && !palavras.includes(p)) palavras.push(p);
  }
  return palavras;
}

/** O domínio do e-mail CONTÉM alguma das palavras? (a parte antes do @ não conta.) */
export function emailCasaDominio(email: string, palavras: readonly string[]): boolean {
  const d = dominioDoEmail(email);
  return !!d && palavras.some((p) => d.includes(p));
}

/** Opções de e-mail da busca, já limpas (vão no job). */
export type OpcoesDeEmail = {
  /** Exclui a EMPRESA se algum e-mail dela tiver indício de contabilidade. */
  ignorarEmailContabilidade: boolean;
  soComEmail: boolean;
  /** Palavras (já limpas) que o domínio do e-mail precisa conter (qualquer uma). Vazio = sem filtro. */
  emailDominio: string[];
};

/** Alguma opção exige saber o e-mail da empresa antes de contá-la? (a busca precisa consultar o CNPJ). */
export const exigeEmail = (o: Pick<OpcoesDeEmail, "soComEmail" | "emailDominio">) => o.soComEmail || o.emailDominio.length > 0;

export type ResultadoDoEmail = { aprovada: boolean; email: string | null; motivo?: "contabilidade" | "sem_email" | "dominio" };

/**
 * Decide a empresa pelos e-mails que ela tem (`principal` e os demais). Ordem:
 * 1. algum e-mail com indício de contabilidade → a empresa SAI (se a opção estiver ligada);
 * 2. "só com e-mail" (ou palavra do domínio): precisa de ao menos um e-mail válido;
 * 3. palavra do domínio: precisa de um e-mail cujo domínio contenha a palavra.
 * Devolve o e-mail que fica no cadastro: o que casou, ou o principal.
 */
export function decidirPorEmail(
  principal: string | null | undefined,
  outros: readonly (string | null | undefined)[],
  o: OpcoesDeEmail,
): ResultadoDoEmail {
  const todos = [principal, ...outros].map((e) => e?.trim()).filter((e): e is string => !!e);
  const unicos = [...new Set(todos.map((e) => e.toLowerCase()))];
  if (o.ignorarEmailContabilidade && unicos.some(emailDeContabilidade)) return { aprovada: false, email: null, motivo: "contabilidade" };
  const validos = unicos.filter(emailValido);
  const fica = principal?.trim().toLowerCase() || null;
  if (!exigeEmail(o)) return { aprovada: true, email: fica };
  if (!validos.length) return { aprovada: false, email: null, motivo: "sem_email" };
  if (o.emailDominio.length) {
    const casou = validos.find((e) => emailCasaDominio(e, o.emailDominio));
    return casou ? { aprovada: true, email: casou } : { aprovada: false, email: null, motivo: "dominio" };
  }
  return { aprovada: true, email: validos.includes(fica ?? "") ? fica : validos[0]! };
}
