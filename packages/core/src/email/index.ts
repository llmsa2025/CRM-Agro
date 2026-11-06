export * from "./service";
export * from "./signatures";
export * from "./plataforma";
export * from "./modelos";
export * from "./sistema";
export * from "./encaminhamento";
export * from "./entrada-assinatura";
export { EMAIL_ENTRADA_QUEUE, enfileirarEmailEncaminhado, jobIdDoEmailEncaminhado } from "./entrada-fila";
export { aceitarEmailEncaminhado, LIMITE_ENTRADA_BYTES, type DecisaoEntrada } from "./entrada-webhook";
export {
  processarEmailEncaminhado,
  REMETENTE_CONFIRMACAO_GMAIL,
  type EmailEncaminhadoJob,
  type ResultadoEncaminhado,
} from "./entrada-encaminhada";
export { pollAllEmailInboxes } from "./leitura-imap";
