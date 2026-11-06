export { normalizePhone, normalizePhoneDetailed, phoneVariants, type PhoneDetail } from "./phone";
export { parseEvolutionStatusUpdate, describeAckError, ACK_ERROR_MEANING, type MessageStatusUpdate } from "./whatsapp/status";
export type { Channel, MessageContent, SendInput, SendOutput, InboundMessage, CallProvider, MakeCallResult, MediaType, SendMediaInput } from "./types";
export { EvolutionProvider } from "./whatsapp/evolution";
export { InstagramProvider } from "./instagram/index";
export { LinkedInProvider } from "./linkedin/index";
export { EmailProvider, describeMailError, classificarErroSmtp, transporteSmtpPara, opcoesDoEmail, type SmtpConfig } from "./email/index";
export { montarMime } from "./email/mime-saida";
export { GmailApiProvider, GmailSemAutorizacao, isGmailSemAutorizacao, type GmailApiConfig } from "./email/gmail-api";
export { evolutionFetch, evolutionHeaders, exigirOk, EVOLUTION_TIMEOUT_MS } from "./whatsapp/http";
// NÃO reexportar o BrowserProvider aqui: ele importa playwright-core, que não pode
// entrar no bundle do web (transpilePackages puxa o barrel). Importe direto de
// "@crmagro/channels/src/browser/index" APENAS em código que roda no worker (tsx).
export type { SocialNetwork, BrowserProxy } from "./types";
export {
  lerEmailsNovos,
  isImapAuthError,
  verifyImap,
  verifyImapDetailed,
  IMAP_LOTE_PADRAO,
  IMAP_MAX_BYTES_PADRAO,
  type ImapConfig,
  type ImapCursor,
  type ImapEnvelope,
  type ImapLeitura,
  type FetchedEmail,
} from "./email/imap";
export { analisarBounce, pareceBounce, remetenteDeAviso, type BounceInfo, type BounceDestinatario } from "./email/bounce";
export { emailDoMime } from "./email/mime";
export {
  parseEvolutionInbound,
  analisarEvolutionInbound,
  segundosDoTimestamp,
  desembrulharMensagem,
  tipoDaMensagemEvolution,
  type MotivoDescarteEvolution,
} from "./whatsapp/inbound";
export {
  baixarMidiaEvolution,
  lerCorpoComLimite,
  MAX_MIDIA_RECEBIDA_BYTES,
  type MidiaBaixada,
} from "./whatsapp/media";
export { verifyEvolutionInstance, type EvolutionVerifyResult } from "./whatsapp/verify";
export {
  createEvolutionInstance,
  getEvolutionQR,
  deleteEvolutionInstance,
  setEvolutionWebhook,
  type EvolutionCreateResult,
  type EvolutionQRResult,
} from "./whatsapp/lifecycle";
export { hasWhatsAppHistory, fetchWhatsAppHistoryPage, fetchWhatsAppChatMessages, type WhatsAppHistoryPage } from "./whatsapp/history";
export {
  buscarParesLidNaEvolution,
  descobrirTelefoneDoLid,
  descobrirLidDoTelefone,
  parLidDaChave,
  ehJidLid,
  type ParLid,
} from "./whatsapp/lid";
export {
  fetchEvolutionInstances,
  fetchEvolutionInstance,
  fetchEvolutionContacts,
  type InstanciaEvolution,
  type ContatoDaAgenda,
} from "./whatsapp/contatos";
export {
  fetchEvolutionProfilePictureUrl,
  baixarFotoDePerfil,
  urlDeFotoPermitida,
  tipoDaImagem,
  MAX_FOTO_PERFIL_BYTES,
  type FotoBaixada,
  type TipoDeImagem,
} from "./whatsapp/foto-perfil";
export {
  checkWhatsAppNumbers,
  WHATSAPP_NUMBERS_LOTE,
  WHATSAPP_NUMBERS_TIMEOUT_MS,
  type NumeroChecado,
} from "./whatsapp/numbers";
export { getChannelProvider, defaultEvolutionProvider } from "./factory";
export type { ChannelAccountRef } from "./factory";
export {
  VoopiProvider,
  voopiConfigSchema,
  voopiWebhookSchema,
  voopiEventKindSchema,
  resultadoDoEventoVoopi,
  type ResultadoVoopi,
  type VoopiConfig,
  type VoopiWebhook,
  type VoopiWebhookEvent,
  type VoopiEventKind,
} from "./voopi/index";
export {
  ChannelSendFailed,
  isChannelSendFailed,
  classificarErroDeRede,
  falhaHttp,
  SessaoSocialInvalida,
  isSessaoSocialInvalida,
  type DesfechoEnvio,
} from "./errors";
export {
  normalizarDestinoSocial,
  exigirDestinoSocial,
  mesmoDestinatario,
  normalizarNome,
  trechoParaConferir,
  type DestinoSocial,
} from "./social/destino";
export { parseEvolutionConnectionEvent, type EventoDeConexao } from "./whatsapp/connection";
