/**
 * Relay hub — store em REDIS (compartilhado web ↔ worker).
 *
 * POR QUE REDIS: o web roda em N instâncias (crmagro-web :3001 + crmagro-web-2 :3002
 * atrás do Caddy com sticky cookie) e o worker é um processo à parte. Um estado
 * EM MEMÓRIA não cruza processos — um job enfileirado no worker nunca chegaria a
 * uma extensão fazendo long-poll numa instância web. O estado (presença + filas
 * por time + resultados) vive no Redis compartilhado; qualquer processo despacha
 * e coleta §2.5.
 *
 * MODELO REDIS:
 *  - Presença:   ZSET relay:agents:{teamId}              member=agentId score=lastSeenMs
 *  - Contas:     SET  relay:agente:{teamId}:{agentId}:contas  contas sociais que o
 *                navegador do agente tem logadas (registradas no connect)
 *  - Presença por conta: ZSET relay:conta:{accountId}:agentes  member=agentId
 *  - Presença por pessoa: ZSET relay:usuario:{teamId}:{userId}:agentes  member=agentId
 *                (para dizer "sua extensão está ligada" sem confundir com a de um colega)
 *  - Fila:       LIST relay:queue:{teamId}               jobs sem conta (http_fetch)
 *  - Fila social: LIST relay:queue:{teamId}:{accountId}  tarefa de UMA conta (DM, item 1.8;
 *                leitura de seguidores do Instagram, `ig_followers`)
 *  - Em curso:   STR  relay:inflight:{jobId}             = teamId, gravado no poll
 *  - Descartado: STR  relay:descartado:{jobId}           job vencido jogado fora no poll
 *  - Pendência:  STR  relay:pending:{jobId}              alguém espera o resultado
 *  - Resultado:  STR  relay:result:{jobId}               o agente devolve; o waiter faz GET
 *
 * FAIL-OPEN: Redis fora do ar degrada com log (não derruba a rota).
 *
 * Antes vivia em apps/web/app/api/relay/_store.ts; foi movido para @crmagro/core
 * para o worker também usar (delegar envio social à extensão). O web reexporta
 * daqui — a interface pública é a mesma.
 */

import { randomUUID } from "node:crypto";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";
import { tipoDeJobPermitido, type RelayJob, type RelayResult, type SocialSendSpec } from "./jobs";

const AGENT_TTL_MS = 30_000;
const RESULT_TTL_MS = 60_000;
const PENDING_TTL_MS = 60_000;
const POLL_INTERVAL_MS = 500; // granularidade do long-poll (RPOP/GET em loop)
// A extensão renova as contas no connect a cada 5 min; sem renovar, somem.
const CONTAS_TTL_MS = 15 * 60_000;
// Job pego pela extensão: tempo máximo de execução (abrir aba, digitar, enviar).
const INFLIGHT_TTL_MS = 5 * 60_000;
// DM social: prazo para a extensão PEGAR o job e, depois de pego, para terminar.
export const RELAY_SOCIAL_ESPERA_MS = 90_000;
export const RELAY_SOCIAL_GRACA_MS = 60_000;

// --- Cliente Redis (singleton lazy, fail-open) -----------------------------

let client: Redis | null = null;
function getClient(): Redis {
  if (!client) {
    client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    client.on("error", (err) => {
      logger.error({ err: err.message }, "[relay-store] erro na conexão Redis");
    });
  }
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const agentsKey = (teamId: string) => `relay:agents:${teamId}`;
const contasDoAgenteKey = (teamId: string, agentId: string) => `relay:agente:${teamId}:${agentId}:contas`;
const agentesDaContaKey = (accountId: string) => `relay:conta:${accountId}:agentes`;
const agentesDoUsuarioKey = (teamId: string, userId: string) => `relay:usuario:${teamId}:${userId}:agentes`;
const queueKey = (teamId: string, accountId?: string) =>
  accountId ? `relay:queue:${teamId}:${accountId}` : `relay:queue:${teamId}`;
const inflightKey = (jobId: string) => `relay:inflight:${jobId}`;
const descartadoKey = (jobId: string) => `relay:descartado:${jobId}`;
const pendingKey = (jobId: string) => `relay:pending:${jobId}`;
const resultKey = (jobId: string) => `relay:result:${jobId}`;

// --- Presença ---------------------------------------------------------------

/**
 * Heartbeat do agente: registra/renova lastSeen no ZSET do time (TTL por score),
 * no da pessoa dona do token (quando conhecida) e em cada conta social que ele atende.
 */
export async function touchAgent(agentId: string, teamId: string, userId?: string | null): Promise<void> {
  try {
    const r = getClient();
    const now = Date.now();
    const key = agentsKey(teamId);
    await r.zadd(key, now, agentId);
    await r.zremrangebyscore(key, 0, now - AGENT_TTL_MS);
    await r.pexpire(key, AGENT_TTL_MS * 2);
    if (userId) {
      const ku = agentesDoUsuarioKey(teamId, userId);
      await r.zadd(ku, now, agentId);
      await r.zremrangebyscore(ku, 0, now - AGENT_TTL_MS);
      await r.pexpire(ku, AGENT_TTL_MS * 2);
    }
    const contas = await r.smembers(contasDoAgenteKey(teamId, agentId));
    for (const accountId of contas) {
      const k = agentesDaContaKey(accountId);
      await r.zadd(k, now, agentId);
      await r.pexpire(k, AGENT_TTL_MS * 2);
    }
  } catch (e) {
    logger.warn({ err: msg(e), agentId, teamId }, "[relay-store] touchAgent fail-open");
  }
}

/**
 * Registra as contas sociais que o navegador do agente tem logadas (item 1.8,
 * INT-08). Os ids já vêm resolvidos NO TIME do token (a rota de connect confere
 * o @usuário contra as contas do time). Substitui o registro anterior.
 */
export async function registrarContasDoAgente(
  teamId: string,
  agentId: string,
  accountIds: string[],
  userId?: string | null,
): Promise<void> {
  try {
    const r = getClient();
    const key = contasDoAgenteKey(teamId, agentId);
    const anteriores = await r.smembers(key);
    const tx = r.multi().del(key);
    if (accountIds.length) tx.sadd(key, ...accountIds).pexpire(key, CONTAS_TTL_MS);
    // Conta que saiu do navegador deixa de ter este agente como entregador.
    for (const antiga of anteriores) if (!accountIds.includes(antiga)) tx.zrem(agentesDaContaKey(antiga), agentId);
    await tx.exec();
    await touchAgent(agentId, teamId, userId);
  } catch (e) {
    logger.warn({ err: msg(e), agentId, teamId }, "[relay-store] registrarContasDoAgente fail-open");
  }
}

/** Quantos agentes do time bateram heartbeat dentro da janela de TTL. */
export async function onlineAgentsForTeam(teamId: string): Promise<number> {
  try {
    const r = getClient();
    const now = Date.now();
    await r.zremrangebyscore(agentsKey(teamId), 0, now - AGENT_TTL_MS);
    return await r.zcount(agentsKey(teamId), now - AGENT_TTL_MS, "+inf");
  } catch (e) {
    logger.warn({ err: msg(e), teamId }, "[relay-store] onlineAgentsForTeam fail-open (0)");
    return 0;
  }
}

/** Quantos agentes online são desta PESSOA (extensão ligada com o token dela). */
export async function agentesOnlineDoUsuario(teamId: string, userId: string): Promise<number> {
  try {
    const r = getClient();
    const now = Date.now();
    const key = agentesDoUsuarioKey(teamId, userId);
    await r.zremrangebyscore(key, 0, now - AGENT_TTL_MS);
    return await r.zcount(key, now - AGENT_TTL_MS, "+inf");
  } catch (e) {
    logger.warn({ err: msg(e), teamId }, "[relay-store] agentesOnlineDoUsuario fail-open (0)");
    return 0;
  }
}

/** Quantos agentes online têm a conta social logada no navegador. */
export async function agentesOnlineDaConta(accountId: string): Promise<number> {
  try {
    const r = getClient();
    const now = Date.now();
    const key = agentesDaContaKey(accountId);
    await r.zremrangebyscore(key, 0, now - AGENT_TTL_MS);
    return await r.zcount(key, now - AGENT_TTL_MS, "+inf");
  } catch (e) {
    logger.warn({ err: msg(e), accountId }, "[relay-store] agentesOnlineDaConta fail-open (0)");
    return 0;
  }
}

// --- Fila de jobs -----------------------------------------------------------

/** Enfileira um job na LIST do time (cruza instâncias; sem waiter em memória). */
export async function pushJob(job: RelayJob): Promise<void> {
  try {
    await getClient().lpush(queueKey(job.teamId), JSON.stringify(job));
  } catch (e) {
    logger.warn({ err: msg(e), teamId: job.teamId }, "[relay-store] pushJob fail-open");
  }
}

/**
 * Tira da fila o próximo job VÁLIDO (vencido é descartado e marcado). Marca o
 * job como "em curso" do time — `deliverResult` só aceita resultado de job que
 * o próprio time pegou.
 */
async function proximoDaFila(r: Redis, fila: string, teamId: string, agora: number, contaDaFila: string | null): Promise<RelayJob | null> {
  for (;;) {
    const raw = await r.rpop(fila);
    if (!raw) return null;
    let job: RelayJob;
    try {
      job = JSON.parse(raw) as RelayJob;
    } catch {
      logger.warn({ teamId }, "[relay-store] job inválido descartado");
      continue;
    }
    // Catálogo fechado: tipo fora da lista nunca chega a uma extensão.
    if (!tipoDeJobPermitido(job.type)) {
      logger.warn({ teamId, jobId: job.id }, "[relay-store] job de tipo fora do catálogo descartado");
      continue;
    }
    if (job.expiresAt && job.expiresAt < agora) {
      await r.set(descartadoKey(job.id), "1", "PX", INFLIGHT_TTL_MS);
      logger.info({ teamId, jobId: job.id, type: job.type }, "[relay-store] job vencido descartado no poll");
      continue;
    }
    // DM do formato ANTIGO (sem validade, sem conta), que sobrou na fila do
    // time de antes do item 1.8: o worker já tinha caído no Playwright e o DM
    // SAIU. Executar agora mandaria o mesmo DM de novo, dias depois, pela conta
    // que estiver logada (auditoria retroativa do #70). DM de verdade só vem
    // pela fila DA CONTA, sempre com `expiresAt`.
    if (job.type === "social_send" && (!job.expiresAt || !(job.spec as { accountId?: string }).accountId)) {
      logger.warn({ teamId, jobId: job.id }, "[relay-store] DM do formato antigo descartado (sem validade/conta)");
      continue;
    }
    // Leitura de seguidores: só pela fila DA CONTA (a mesma conta da tarefa) e sempre com validade.
    // Na fila do time ela iria para a extensão de QUALQUER pessoa do time, e não é essa a regra.
    if (job.type === "ig_followers" && (!job.expiresAt || !contaDaFila || (job.spec as { accountId?: string }).accountId !== contaDaFila)) {
      logger.warn({ teamId, jobId: job.id }, "[relay-store] ig_followers fora da fila da conta (ou sem validade) descartado");
      continue;
    }
    await r.set(inflightKey(job.id), teamId, "PX", INFLIGHT_TTL_MS);
    return job;
  }
}

/**
 * Long-poll: procura job nas filas das contas que o agente atende e na fila do
 * time, até achar ou estourar timeoutMs. Também renova o heartbeat do agente.
 * Retorna null no timeout.
 */
export async function waitForJob(teamId: string, agentId: string, timeoutMs: number, userId?: string | null): Promise<RelayJob | null> {
  await touchAgent(agentId, teamId, userId);
  const deadline = Date.now() + timeoutMs;
  let filas: { fila: string; conta: string | null }[] = [{ fila: queueKey(teamId), conta: null }];
  try {
    const contas = await getClient().smembers(contasDoAgenteKey(teamId, agentId));
    filas = [...contas.map((c) => ({ fila: queueKey(teamId, c), conta: c })), { fila: queueKey(teamId), conta: null }];
  } catch (e) {
    logger.warn({ err: msg(e), teamId }, "[relay-store] contas do agente indisponíveis — só a fila do time");
  }
  while (Date.now() < deadline) {
    try {
      const r = getClient();
      for (const { fila, conta } of filas) {
        const job = await proximoDaFila(r, fila, teamId, Date.now(), conta);
        if (job) return job;
      }
    } catch (e) {
      logger.warn({ err: msg(e), teamId }, "[relay-store] waitForJob fail-open (null)");
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Põe uma tarefa na fila DA CONTA e devolve o texto exato que foi enfileirado
 * (para tirá-la depois com `removerDaFilaDaConta`). Diferente do DM, ninguém fica
 * esperando o resultado aqui: quem enfileira acompanha por outro caminho (a
 * leitura de seguidores atualiza o status do lote). A LIST expira sozinha.
 * Lança se o Redis não aceitar (quem chama trata como "não enfileirou").
 */
export async function enfileirarNaFilaDaConta(job: RelayJob, accountId: string, ttlMs: number): Promise<string> {
  const payload = JSON.stringify(job);
  const fila = queueKey(job.teamId, accountId);
  await getClient().multi().lpush(fila, payload).pexpire(fila, ttlMs + 60_000).exec();
  return payload;
}

/** Tira da fila da conta uma tarefa que ninguém pegou. `true` = estava lá e saiu. */
export async function removerDaFilaDaConta(teamId: string, accountId: string, payload: string): Promise<boolean> {
  try {
    return (await getClient().lrem(queueKey(teamId, accountId), 1, payload)) === 1;
  } catch (e) {
    logger.warn({ err: msg(e), teamId }, "[relay-store] removerDaFilaDaConta falhou");
    return false;
  }
}

// --- Resultados -------------------------------------------------------------

/**
 * Registra a espera pelo resultado (marca pendência no Redis) e faz GET em loop
 * até o agente devolver ou estourar.
 */
export async function awaitResult(jobId: string, timeoutMs: number): Promise<RelayResult> {
  try {
    await getClient().set(pendingKey(jobId), "1", "PX", Math.max(PENDING_TTL_MS, timeoutMs + 5_000));
  } catch (e) {
    logger.warn({ err: msg(e), jobId }, "[relay-store] awaitResult (pending) fail-open");
  }
  const deadline = Date.now() + timeoutMs;
  const key = resultKey(jobId);
  while (Date.now() < deadline) {
    try {
      const raw = await getClient().get(key);
      if (raw) {
        await getClient().del(key, pendingKey(jobId));
        return JSON.parse(raw) as RelayResult;
      }
    } catch (e) {
      logger.warn({ err: msg(e), jobId }, "[relay-store] awaitResult fail-open (timeout)");
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { jobId, ok: false, error: "timeout" };
}

/**
 * Entrega o resultado devolvido pelo agente: grava no Redis para o waiter (em
 * QUALQUER processo) consumir. Só aceita resultado de job que o PRÓPRIO time
 * pegou no poll (`relay:inflight:{jobId}` = teamId) — antes, qualquer token de
 * qualquer time podia responder por um jobId alheio. Retorna se havia alguém
 * esperando (pendência).
 */
export async function deliverResult(result: RelayResult, teamId: string): Promise<boolean> {
  try {
    const r = getClient();
    const dono = await r.get(inflightKey(result.jobId));
    if (dono !== teamId) {
      logger.warn({ jobId: result.jobId, teamId }, "[relay-store] resultado de job que o time não pegou — ignorado");
      return false;
    }
    const wasPending = (await r.exists(pendingKey(result.jobId))) === 1;
    await r.multi().set(resultKey(result.jobId), JSON.stringify(result), "PX", RESULT_TTL_MS).del(inflightKey(result.jobId)).exec();
    return wasPending;
  } catch (e) {
    logger.warn({ err: msg(e), jobId: result.jobId }, "[relay-store] deliverResult fail-open (false)");
    return false;
  }
}

// --- Helpers de alto nível --------------------------------------------------

/**
 * Resultado do envio social pela extensão:
 * - `no_agent`: nenhuma extensão com a conta logada está online → nada saiu;
 * - `relay_indisponivel`: não deu para enfileirar (Redis) → nada saiu;
 * - `timeout`: ninguém PEGOU o job e ele foi retirado da fila → nada saiu;
 * - `incerto`: a extensão pegou o job e não respondeu → PODE ter saído;
 * - qualquer outro `error`: a extensão respondeu (código em `executeSocialSend`).
 */
export type ResultadoRelaySocial = RelayResult;

/**
 * Delega um envio de DM social à extensão que tem a CONTA logada (item 1.8) e
 * espera o resultado. Antes, o job ia para a fila do TIME sem validade: se a
 * extensão demorava, o worker caía no Playwright e o job continuava na fila —
 * o DM saía duas vezes, às vezes no dia seguinte (INT-07/MF-11); e a extensão
 * de outro vendedor podia pegá-lo e enviar da conta pessoal dele (INT-08).
 *
 * Agora: fila por conta com validade; no timeout, `LREM` — se removeu, ninguém
 * pegou (fallback seguro); se não removeu, a extensão está com o job: espera a
 * graça e, sem resposta, devolve `incerto` (o motor segura para revisão).
 */
export async function relaySocialSend(
  teamId: string,
  spec: SocialSendSpec,
  opts?: { waitMs?: number; gracaMs?: number },
): Promise<ResultadoRelaySocial> {
  if ((await agentesOnlineDaConta(spec.accountId)) < 1) return { jobId: "", ok: false, error: "no_agent" };

  const waitMs = opts?.waitMs ?? RELAY_SOCIAL_ESPERA_MS;
  const agora = Date.now();
  const job: RelayJob = {
    id: randomUUID(),
    teamId,
    type: "social_send",
    spec,
    createdAt: agora,
    expiresAt: agora + waitMs,
  };
  const payload = JSON.stringify(job);
  const fila = queueKey(teamId, spec.accountId);
  try {
    // A LIST expira sozinha se ninguém mais enfileirar nela.
    await getClient().multi().lpush(fila, payload).pexpire(fila, waitMs + 60_000).exec();
  } catch (e) {
    logger.warn({ err: msg(e), teamId }, "[relay-store] não enfileirou o DM social");
    return { jobId: job.id, ok: false, error: "relay_indisponivel" };
  }

  const r = await awaitResult(job.id, waitMs);
  if (r.error !== "timeout") return r;

  let removido = -1;
  try {
    removido = await getClient().lrem(fila, 1, payload);
  } catch (e) {
    logger.warn({ err: msg(e), jobId: job.id }, "[relay-store] LREM falhou — tratando como pego");
  }
  if (removido === 1) return { jobId: job.id, ok: false, error: "timeout" };
  // Não estava mais na fila: ou venceu e o poll descartou (nada saiu), ou a
  // extensão pegou e ainda está enviando.
  try {
    if ((await getClient().exists(descartadoKey(job.id))) === 1) return { jobId: job.id, ok: false, error: "timeout" };
  } catch {
    // sem como saber: segue como pego
  }
  const tarde = await awaitResult(job.id, opts?.gracaMs ?? RELAY_SOCIAL_GRACA_MS);
  if (tarde.error !== "timeout") return tarde;
  return { jobId: job.id, ok: false, error: "incerto" };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
