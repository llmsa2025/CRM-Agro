/**
 * Avaliação do Google Maps (produto §H.4): nota (ex.: 4,8) e nº de avaliações
 * (ex.: 61) de um lugar. PURO — sem Playwright: o worker só junta os textos
 * (`aria-label` do card do feed e da ficha) dentro do navegador e passa para cá.
 *
 * O Maps escreve de vários jeitos, conforme a tela e o idioma:
 * - card do feed: `aria-label="4,8 estrelas 61 avaliações"` (en: "4.8 stars 61 Reviews");
 * - ficha: `aria-label="4,8 estrelas "` + `aria-label="61 avaliações"` separados,
 *   e o texto visível `4,8(61)`;
 * - milhar com ponto ("1.234 avaliações") ou vírgula no inglês ("1,234 reviews");
 * - lugar sem avaliação: "Nenhuma avaliação" / "No reviews".
 */

export type AvaliacaoMaps = { avaliacao: number | null; avaliacoes: number | null };

// Nota: um dígito, separador decimal e um dígito (o Maps sempre mostra 1 casa).
const RE_NOTA = /(?:^|[^\d])([0-5])[,.](\d)\s*(?:estrelas?|stars?)\b/i;
// Contagem antes de "avaliações"/"reviews" (milhar com ponto, vírgula ou espaço fino).
const RE_CONTAGEM = /(?:^|[^\d,.])(\d{1,3}(?:[.,\s\u00a0\u202f]\d{3})*|\d+)\s*(?:avalia[çc](?:[õo]es|[ãa]o)|reviews?)\b/i;
// Texto visível da ficha: "4,8(61)" ou "4,8 (1.234)".
const RE_TEXTO = /(?:^|\s)([0-5])[,.](\d)\s*\(\s*(\d{1,3}(?:[.,\s\u00a0\u202f]\d{3})*|\d+)\s*\)/;

const inteiro = (s: string) => {
  const n = Number(s.replace(/[.,\s\u00a0\u202f]/g, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const nota = (a: string, b: string) => {
  const n = Number(`${a}.${b}`);
  return n >= 1 && n <= 5 ? n : null;
};

/** Lê nota e contagem de UM texto (aria-label ou texto visível). */
export function parseAvaliacaoMaps(texto: string | null | undefined): AvaliacaoMaps {
  const t = (texto ?? "").trim();
  if (!t) return { avaliacao: null, avaliacoes: null };
  const vis = t.match(RE_TEXTO);
  if (vis) return { avaliacao: nota(vis[1]!, vis[2]!), avaliacoes: inteiro(vis[3]!) };
  const n = t.match(RE_NOTA);
  const c = t.match(RE_CONTAGEM);
  return { avaliacao: n ? nota(n[1]!, n[2]!) : null, avaliacoes: c ? inteiro(c[1]!) : null };
}

const normalizarNome = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Junta vários textos (todos os `aria-label` do card, depois os da ficha): a 1ª
 * nota e a 1ª contagem achadas vencem. Nota sem contagem é aceita (o Maps às
 * vezes esconde o número); contagem sem nota, também.
 *
 * `nome` = nome do lugar: o `aria-label` do próprio card É o nome, e um lugar
 * chamado "Pousada 5.0 Estrelas" viraria nota 5,0. Rótulo igual ao nome (ou
 * que só o repete, como "Rotas para <nome>") é descartado antes do parse.
 */
export function extrairAvaliacaoMaps(
  textos: readonly (string | null | undefined)[],
  opts: { nome?: string | null } = {},
): AvaliacaoMaps {
  const nome = normalizarNome(opts.nome);
  let avaliacao: number | null = null;
  let avaliacoes: number | null = null;
  for (const t of textos) {
    if (avaliacao !== null && avaliacoes !== null) break;
    const n = normalizarNome(t);
    // Nome curto demais ("Bar") não serve de filtro por "contém": só o igual.
    if (nome && (n === nome || (nome.length >= 4 && n.includes(nome)))) continue;
    const r = parseAvaliacaoMaps(t);
    avaliacao ??= r.avaliacao;
    avaliacoes ??= r.avaliacoes;
  }
  return { avaliacao, avaliacoes };
}
