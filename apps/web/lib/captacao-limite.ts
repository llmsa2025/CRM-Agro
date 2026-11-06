/**
 * Quantidade de contatos a capturar no Instagram. Regra pura (o campo da tela e a
 * action do servidor usam a mesma), para valor vazio, negativo ou fora do teto nunca
 * virar um job gigante ou zerado.
 */
export const LIMITE_INSTAGRAM_PADRAO = 100;
export const LIMITE_INSTAGRAM_MAX = 300;

/** Texto digitado ou número → inteiro entre 1 e o teto. Inválido volta ao padrão. */
export function limiteDeCaptura(valor: unknown, padrao = LIMITE_INSTAGRAM_PADRAO, max = LIMITE_INSTAGRAM_MAX): number {
  const texto = typeof valor === "number" ? "" : String(valor ?? "").trim();
  // Number("") é 0: campo vazio tem de voltar ao padrão, não virar 1.
  if (typeof valor !== "number" && texto === "") return padrao;
  const n = typeof valor === "number" ? valor : Number(texto.replace(",", "."));
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(Math.floor(n), 1), max);
}
