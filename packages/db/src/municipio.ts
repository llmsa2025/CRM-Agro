/**
 * Chave de busca de lugar (produto §B.1): sem acento, minúsculo, pontuação
 * vira espaço, espaços colapsados. "Olho d'Água" → "olho d agua";
 * "São Paulo" e "Sao  Paulo" → "sao paulo".
 *
 * Fonte ÚNICA: grava `Municipio.nomeBusca` no seed e monta a busca por
 * "cidade/UF" na geocodificação — se as duas divergirem, a cidade não casa.
 */
export function nomeBuscaLugar(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
