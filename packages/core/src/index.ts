// @crmagro/core — domínio (schemas zod + serviços puros).
export * from "./shared/index";
export * from "./auth/index";
export * from "./contacts/index";
export * from "./importacao/index";
export * from "./campaigns/index";
export * from "./tags/index";
export * from "./channels-limit/index";
export * from "./calls/index";
export * from "./funnels/index";
export * from "./conversations/index";
export * from "./flows/index";
export * from "./companies/index";
export * from "./email/index";
export * from "./agenda/index";
export * from "./captacao/index";
export * from "./geo/index";
export * from "./produtor/index";
export * from "./agro/index";
export * from "./enrichment/index";
export * from "./social/index";
export * from "./integrations/index";
export * from "./relay/index";
export * from "./ai/index";
export * from "./conhecimento/index";
export * from "./metodologias/index";
export * from "./dashboard/service";
export * from "./dashboard/tarefas-feitas";
export * from "./storage/service";
export * from "./storage/media-policy";
export * from "./storage/limpeza";
export * from "./tenancy/index";
export * from "./dono/index";
export * from "./http/index";
export * from "./retencao/index";
export * from "./motor-do-dia/index";
export * from "./goals/index";
export * from "./health/index";
export * from "./events/index";
export * from "./push/index";
export { rateLimit, peekRateLimit, resetRateLimit, type RateLimitResult } from "./rate-limit/service";
export { logger } from "./logger/index";
// Fachada de normalização (Fase 1: telefone). Namespace p/ não colidir com o
// `normalizePhone` (string|null) já exportado por contacts. Uso: normalize.normalizePhone(raw).
export * as normalize from "./normalize/index";
export { type NormalizeResult } from "./normalize/index";
// Versão rica do primitivo de telefone, p/ quem quiser canonical+display+valid direto.
export { normalizePhoneDetailed, type PhoneDetail } from "@crmagro/channels";
export { parseEvolutionInbound, type InboundMessage } from "@crmagro/channels";
