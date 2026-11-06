export {
  listConversations,
  listarTodasAsConversas,
  listMessages,
  sendMessage,
  sendMediaMessage,
  sendTyping,
  applyStatusUpdate,
  receiveInbound,
  markRead,
  deleteConversation,
  registerContactForConversation,
  cadastrarContatoDaConversa,
  type ContatoCadastradoDaConversa,
  startConversationWithContact,
  startConversationWithNumber,
} from "./service";
export {
  encaminharMensagens,
  listarDestinosDeEncaminhamento,
  recusaDoDestino,
  assuntoEncaminhado,
  montarCorpoEncaminhado,
  EncaminhamentoInvalido,
  MAX_DESTINOS_ENCAMINHAR,
  MAX_MENSAGENS_ENCAMINHAR,
  type DestinoDeEncaminhamento,
  type ResultadoDestino,
  type ResultadoEncaminhamento,
} from "./encaminhar";
export { fotoDaConversa, type FotoDaConversa } from "./foto";
export { emitConversationEvent } from "./events";
export { EnvioAindaNaoConfirmado } from "./envio-incerto";
export {
  classificarOptOut,
  marcarOptOut,
  normalizarTexto,
  REGRAS_OPT_OUT,
  TAG_PEDIU_PARA_SAIR,
  MOTIVO_PEDIU_PARA_SAIR,
  type DecisaoOptOut,
  type ResultadoOptOut,
} from "./opt-out";
export type { ConversationEvent } from "./events";
export {
  sendMessageSchema,
  createChannelAccountSchema,
  listConversationsInputSchema,
  listMessagesInputSchema,
} from "./schema";
export type {
  SendMessageInput,
  CreateChannelAccountInput,
  ConversationListItem,
  ConversationPage,
  ListConversationsInput,
  ListMessagesInput,
  MessageDTO,
  MessagePage,
} from "./schema";
export { CONVERSAS_POR_PAGINA, MENSAGENS_POR_PAGINA } from "./service";
export { countUnreadConversations } from "./ultima-mensagem";
export { processInboundJob, dataDaMensagem, resolveInboundAccount } from "./service";
export {
  INBOUND_QUEUE,
  enqueueInbound,
  acceptWhatsAppWebhook,
  inboundJobId,
  esperaDoInbound,
  reprocessarInboundFalhos,
  inboundFalhosUltimaHora,
  INBOUND_TENTATIVAS,
  INBOUND_BACKOFF,
  type InboundJob,
  type WebhookDecision,
} from "./inbound-queue";
export { escopoCanal, escopoConversa } from "./escopo";
export {
  aplicarParLid,
  descobrirEUnificarLid,
  sugerirUnificacaoLid,
  unificarConversaSemNumero,
  ConversaJaTemNumero,
  ContatoSemWhatsApp,
  LidComOutroNumero,
  NumeroDoLidNaoEncontrado,
  type AlvoDaUnificacao,
  type ResultadoUnificacao,
  type SugestaoUnificacao,
} from "./unificar-lid";
export { gravarParesLid, lerParesLid, type OrigemParLid } from "./lid-mapa";
export {
  listarConversasLidParaRevisao,
  mascararTelefone,
  somenteLeitura,
  type DestinoDoPar,
  type LinhaLid,
  type RevisaoLid,
} from "./lid-revisao";
