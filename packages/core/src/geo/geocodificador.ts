/**
 * Provedor de geocodificação PLUGÁVEL (produto §B.2). Hoje: Nominatim
 * (OpenStreetMap, decisão do dono). Trocar por MapTiler/Google é escrever outra
 * classe com esta interface e mudar `geocodificadorPadrao()` — o resto
 * (cache, centroide da cidade, contato, backfill) não muda.
 */

export type PrecisaoProvedor = "endereco" | "cidade";

export type ResultadoProvedor = { latitude: number; longitude: number; precisao: PrecisaoProvedor };

export interface Geocodificador {
  /** Vai para `GeoCache.fonte` e `geoFonte` do contato. */
  readonly nome: string;
  /**
   * `null` = o provedor respondeu e NÃO achou (fica em cache). Exceção =
   * falha passageira (rede, 429, 5xx, sem vez): não vai para o cache e o
   * contato é tentado de novo depois.
   */
  buscar(consulta: string): Promise<ResultadoProvedor | null>;
}

/** Falha passageira do provedor — tentar de novo mais tarde. */
export class GeocodificadorIndisponivel extends Error {
  constructor(motivo: string) {
    super(`geocodificador indisponível: ${motivo}`);
    this.name = "GeocodificadorIndisponivel";
  }
}
