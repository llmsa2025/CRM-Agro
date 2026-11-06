// Utilitários puros da automação de navegador (item 3.2). Nenhum importa
// Playwright: o worker os usa em volta das chamadas dele.
export { comPrazo, comTeto, PrazoEsgotado, type ResultadoTeto } from "./prazo";
export { detectarBloqueioGoogle, type BloqueioGoogle } from "./bloqueio";
export {
  acharChromiumOrfaos,
  pidDoMarcador,
  MARCADOR_PID_WORKER,
  type ProcessoInfo,
  type ChromiumOrfao,
} from "./orfaos";
