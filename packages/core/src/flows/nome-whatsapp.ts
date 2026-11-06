/**
 * Nome do WhatsApp pronto para o cadastro: fica só o que é nome. Tira emoji, símbolos, parênteses e sobras
 * ("João 🌾" vira "João", "✨ Ana Paula ✨" vira "Ana Paula") e recusa o que não tem nome de verdade (um caractere,
 * só emoji, só símbolo, só número). Nome junto ("MariaSilva") ou com espaço ("Maria Silva") valem igual.
 * Precisa de pelo menos 2 letras.
 */
export function limparNomeDoWhatsApp(bruto: string | null | undefined): string | null {
  const s = (bruto ?? "")
    .normalize("NFC")
    .replace(/\u200B|\u200C|\u200D|\u2060|\uFE0E|\uFE0F|\u20E3/g, "") // emenda de emoji, seletor de variação, keycap
    .replace(/[^\p{L}\p{M}\p{N}\s'’.-]/gu, " ") // emoji, símbolos, parênteses...
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
  const letras = (s.match(/\p{L}/gu) ?? []).length;
  return letras >= 2 ? s : null;
}
