// Mapa (produto §B.2): geocodificação. O provedor é plugável (`Geocodificador`).
export { normalizarEndereco, ufDe, geoHashDe, distanciaKm, type EnderecoNormalizado, type NivelEndereco } from "./endereco";
export { GeocodificadorIndisponivel, type Geocodificador, type ResultadoProvedor, type PrecisaoProvedor } from "./geocodificador";
export { NominatimGeocodificador, geocodificadorPadrao, reservarVezNominatim, NOMINATIM_PUBLICO } from "./nominatim";
export {
  geocodificar,
  geocodificarContato,
  geocodificarEmpresa,
  centroideDaCidade,
  backfillGeocode,
  type ResultadoGeo,
  type ResultadoBackfill,
} from "./geocode";
export { GEO_QUEUE, agendarBackfillGeo, processarJobGeo, type JobGeo } from "./fila";
// Consulta do mapa e rota do dia (produto §B.3).
export * from "./mapa";
// Pino manual (criar contato pelo mapa / corrigir posição) e cidade/UF do ponto.
export { definirLocalizacaoManual, cidadeDoPonto, HASH_MANUAL, ContatoNaoLocalizavel, pontoSchema, type Ponto, type LugarDoPonto } from "./manual";
export * from "./rota";
// Camadas do mapa (estilo Google My Maps).
export {
  listCamadas,
  createCamada,
  updateCamada,
  deleteCamada,
  moverContatosParaCamada,
  contatoNoMapa,
  camadaInputSchema,
  CORES_CAMADA,
  CamadaNaoEncontrada,
  CamadaJaExiste,
  type CamadaDTO,
  type CamadaInput,
  type ContatoNoMapaDTO,
} from "./camadas";
