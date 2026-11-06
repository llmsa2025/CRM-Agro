/**
 * Regras PURAS da tela de fonte paga: preço do crédito em reais ↔ centavos e o texto do custo
 * mostrado ANTES de consultar. Sem React e sem rede.
 */

/** "1,50", "R$ 0,75", "2" → centavos. Vazio → null. Inválido (ou negativo, ou acima de R$ 1.000) → "invalido". */
export function reaisParaCentavos(texto: string): number | null | "invalido" {
  const t = texto.replace(/R\$/gi, "").trim();
  if (!t) return null;
  if (!/^\d+([.,]\d{1,2})?$/.test(t.replace(/\s/g, ""))) return "invalido";
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 1000) return "invalido";
  return Math.round(n * 100);
}

/** 150 → "R$ 1,50". */
export function centavosParaReais(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

/** Texto do custo: "3 créditos (cerca de R$ 4,50)"; sem o preço do crédito, só os créditos. */
export function textoDoCusto(creditos: number, centavos: number | null): string {
  const c = `${creditos} ${creditos === 1 ? "crédito" : "créditos"}`;
  return centavos === null ? c : `${c} (cerca de ${centavosParaReais(centavos)})`;
}
