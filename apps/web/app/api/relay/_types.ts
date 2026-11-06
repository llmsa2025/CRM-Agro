/**
 * Relay hub — tipos e validação de jobs.
 *
 * MOVIDO para @crmagro/core (packages/core/src/relay/jobs.ts) para o worker também
 * usar o contrato. Este arquivo só reexporta — as rotas continuam importando de
 * "../_types" sem mudança
 */
export {
  type RelayJobType,
  type HttpFetchSpec,
  type DomActionSpec,
  type SocialSendSpec,
  type IgFollowersSpec,
  type RelayJob,
  type RelayResult,
  RELAY_JOB_TYPES,
  tipoDeJobPermitido,
  ALLOWED_METHODS,
  isUrlAllowed,
  RELAY_ALLOWLIST,
} from "@crmagro/core";
