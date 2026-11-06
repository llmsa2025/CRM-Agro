/**
 * Relay hub — store (Redis).
 *
 * MOVIDO para @crmagro/core (packages/core/src/relay/hub.ts) para o worker também
 * despachar/coletar jobs (delegar envio social à extensão). Este arquivo só
 * reexporta — as rotas continuam importando de "../_store" sem mudança.
 * §2.5.
 */
export {
  touchAgent,
  onlineAgentsForTeam,
  pushJob,
  waitForJob,
  awaitResult,
  deliverResult,
  relaySocialSend,
  registrarContasDoAgente,
} from "@crmagro/core";
