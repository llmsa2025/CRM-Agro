export * from "./schema";
export {
  createCampaign,
  saveStep,
  getCampaign,
  listCampaigns,
  prepararLista,
  montarLista,
  liberarSegurados,
  previewMessage,
  textoParaContato,
  escolherVariacao,
  lerColados,
  CampaignNotFound,
  CampaignNaoEditavel,
  type CampaignDTO,
  type ContagemPorStatus,
  type EstadoDaLista,
  type ResumoDaLista,
  type EtapaCampanha,
} from "./service";
export { CAMPAIGN_QUEUE, campaignJobId, type CampaignJob } from "./queue";
export {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  estimate,
  minutosDeJanela,
  capacidadePeloRitmo,
  CampaignNaoPodeIniciar,
  CampaignEstadoInvalido,
  type Previsao,
} from "./controle";
export { registrarRespostaDeCampanha, aplicarReciboDeCampanha } from "./resposta";
// Classificação da resposta (produto §A.5) — o worker da fila `ai` consome.
export {
  agendarClassificacaoDaResposta,
  processarClassificacao,
  listarSugestoesDeSaida,
  corrigirClassificacao,
  CLASSES_DE_RESPOSTA,
  JOB_CLASSIFICAR_RESPOSTA,
  DestinatarioNaoEncontrado,
  type ClasseDeResposta,
  type ClassificacaoJob,
} from "./classificacao";
export {
  linhasDaPlanilha,
  listarDestinatarios,
  PlanilhaSemTelefone,
  type LinhaDaPlanilha,
  type DestinatarioDTO,
  type PaginaDeDestinatarios,
} from "./tela";
export { processarTickDaCampanha, proximaJanelaDaCampanha, TickOcupado, type DesfechoDoTick } from "./tick";
export { varrerCampanhasParadas, MOTIVO_PARADA_REPETIDA } from "./varredura";
