import { z } from "zod";

/**
 * Schemas zod da Voopi (tronco SIP / click-to-call) — uma fonte de verdade.
 * Tipos via z.infer (AGENTS.md: zod em toda borda).
 *
 * Por que existe: o discador progressivo origina ligações via tronco Voopi
 * (R$0,08/min fixo, R$0,35/min celular). A config descreve a registradora
 * SIP; o webhook normaliza os eventos de ciclo de vida da chamada.
 *
 * NOTA: os campos `sipHost`/`sipPort` descrevem o tronco SIP (ex.:
 * `sip.voopi.com.br:5060`). A API REST de click-to-call da Voopi — que faz o
 * SIP INVITE do lado dela a partir deste tronco — é derivada do `sipHost`
 * (ver `VoopiProvider.apiBase()`). Confirmar paths/payload contra a doc da
 * Voopi ao conectar a primeira instância real (mesmo espírito do
 * `EvolutionProvider.sendPresence`, ainda não validado contra a instância viva).
 */

/**
 * Configuração da registradora/conta Voopi. Os mesmos `sipUser`/`sipPassword`
 * autenticam o tronco SIP e a API REST de click-to-call (Basic Auth) — a Voopi
 * usa a mesma conta. `webhookUrl` é pública (sem SSO) e pra onde a Voopi devolve
 * `call.answered`/`call.ended`/`call.recording` (ver endpoint no apps/web).
 *
 * Todos string e não-vazios (telefone/conta não nulos). `webhookUrl` é opcional:
 * o provider consegue originar sem callback, só não realimenta status.
 */
export const voopiConfigSchema = z.object({
  sipHost: z.string().trim().min(1, "sipHost obrigatório"),
  sipPort: z.string().trim().min(1, "sipPort obrigatório"),
  sipUser: z.string().trim().min(1, "sipUser obrigatório"),
  sipPassword: z.string().min(1, "sipPassword obrigatório"),
  webhookUrl: z.string().trim().url("webhookUrl deve ser uma URL"),
});
export type VoopiConfig = z.infer<typeof voopiConfigSchema>;

/** Eventos de ciclo de vida que a Voopi sinaliza de volta via webhook. */
export const voopiEventKindSchema = z.enum([
  "call.answered",
  "call.ended",
  "call.recording",
]);
export type VoopiEventKind = z.infer<typeof voopiEventKindSchema>;

/**
 * Payload do webhook da Voopi. `callId` é o id da chamada no provider (devolvido
 * por `makeCall` como `providerCallId`); o webhook do app o casa com a row Call
 * por esse id (índice `@@index([providerCallId])` no Prisma).
 *
 * `duration`/`recordingUrl` são condicionais ao evento: vêm só no `call.ended`
 * /`call.recording`, respectivamente — por isso opcionais aqui. O schema aceita
 * campos extra (`.passthrough()`) pra tolerar variações entre versões da Voopi,
 * extraindo só o que importa (mesma estratégia do inbound da Evolution).
 */
export const voopiWebhookSchema = z
  .object({
    event: voopiEventKindSchema,
    callId: z.string().trim().min(1, "callId obrigatório"),
    from: z.string().trim().min(1, "from obrigatório"),
    to: z.string().trim().min(1, "to obrigatório"),
    duration: z.number().int().nonnegative().optional(),
    recordingUrl: z.string().trim().url("recordingUrl deve ser uma URL").optional(),
    // Como a ligação terminou (no `call.ended`). O nome do campo NÃO foi
    // validado contra a Voopi: aceitamos as variantes comuns de PABX/SIP e
    // `resultadoDoEventoVoopi` normaliza. Ausente = a Voopi não disse.
    result: z.string().trim().optional(),
    hangupCause: z.string().trim().optional(),
    hangup_cause: z.string().trim().optional(),
  })
  .passthrough();
export type VoopiWebhook = z.infer<typeof voopiWebhookSchema>;

/** Resultado que a Voopi pode informar (subconjunto do resultado da ligação). */
export type ResultadoVoopi = "answered" | "no_answer" | "busy" | "voicemail";

/** Valores conhecidos (minúsculo, sem acento, `_` no lugar de espaço/hífen). */
const RESULTADOS_VOOPI: Record<string, ResultadoVoopi> = {
  answered: "answered",
  answer: "answered",
  atendida: "answered",
  normal_clearing: "answered",
  no_answer: "no_answer",
  noanswer: "no_answer",
  nao_atendida: "no_answer",
  no_user_response: "no_answer",
  originator_cancel: "no_answer",
  busy: "busy",
  user_busy: "busy",
  ocupado: "busy",
  voicemail: "voicemail",
  caixa_postal: "voicemail",
  machine: "voicemail",
  answering_machine: "voicemail",
};

/**
 * Resultado da ligação informado pela Voopi no evento (ou `null` se ela não
 * disse, ou disse algo que não conhecemos — aí quem decide é o vendedor).
 * `normal_clearing` só conta como atendida se a ligação teve duração.
 */
export function resultadoDoEventoVoopi(ev: VoopiWebhook): ResultadoVoopi | null {
  const bruto = ev.result ?? ev.hangupCause ?? ev.hangup_cause;
  if (!bruto) return null;
  const chave = bruto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const r = RESULTADOS_VOOPI[chave] ?? null;
  if (chave === "normal_clearing" && !ev.duration) return null;
  return r;
}

/**
 * Evento normalizado de webhook — já validado pelo zod. É o mesmo shape do
 * `VoopiWebhook` (mantido explicitamente pra desacoplar o consumidor do schema
 * interno e documentar o contrato do `VoopiProvider.parseWebhook`).
 */
export type VoopiWebhookEvent = VoopiWebhook;
