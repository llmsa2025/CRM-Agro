import { db } from "@crmagro/db";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";

/**
 * Limites anti-loop e anti-spam do motor (item 1.4 — MF-08, MF-21).
 *
 * - teto de passos por inscrição (`FLOW_MAX_STEPS`, 200): um ciclo sem espera
 *   (`envia → tag → envia`) rodava na velocidade do limitador e mandava a MESMA
 *   mensagem ao mesmo contato até acabar a cota do número;
 * - limite por CONTATO (`FLOW_MAX_SENDS_PER_CONTACT_24H`, 3 envios
 *   automáticos em 24 h, somando todos os fluxos) — a cota era só por conta;
 * - profundidade de gatilho (`PROFUNDIDADE_MAX`, 2): cascata do próprio motor
 *   (mover etapa → stage_changed → outro fluxo move de volta…) para no 3º nível;
 * - reentrada (`triggerConfig.reentry`) e exclusividade (`triggerConfig.exclusivo`).
 */

export const FLOW_MAX_STEPS = Number(process.env.FLOW_MAX_STEPS ?? 200);
export const MAX_ENVIOS_CONTATO_24H = Number(process.env.FLOW_MAX_SENDS_PER_CONTACT_24H ?? 3);
export const PROFUNDIDADE_MAX = 2;
const JANELA_CONTATO_MS = 24 * 60 * 60_000;

/** Cooldown padrão de reentrada do `message_received` (anti pingue-pongue bot↔bot). */
export const COOLDOWN_PADRAO_MENSAGEM_H = 24;

const chaveContato = (contactId: string) => `flow:contact:${contactId}:sends`;

/**
 * Reserva 1 envio automático para o contato. Excedeu → devolve quanto esperar
 * (até a janela de 24 h zerar). Redis indisponível → libera (a fila do motor
 * também depende do Redis; não é aqui que o motor deve parar).
 */
// INCR + prazo de expiração num passo só (auditoria do #64): antes eram dois
// comandos (`INCR` e, se n = 1, `PEXPIRE`); se o processo caísse entre eles, a
// chave ficava SEM TTL e, ao chegar a 3, o contato ficava bloqueado para envio
// automático PARA SEMPRE. O script também cura uma chave que já esteja sem TTL.
const RESERVAR_LUA = `
local n = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if n <= tonumber(ARGV[2]) then return {1, 0} end
redis.call('DECR', KEYS[1])
return {0, redis.call('PTTL', KEYS[1])}
`;

// Devolve sem criar chave nova (DECR numa chave inexistente criaria "-1" sem TTL).
const DEVOLVER_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local n = redis.call('DECR', KEYS[1])
if n < 0 then redis.call('SET', KEYS[1], '0', 'KEEPTTL') end
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return 1
`;

export async function reservarEnvioAoContato(
  contactId: string,
): Promise<{ ok: true } | { ok: false; esperaMs: number }> {
  try {
    const [ok, pttl] = (await redisEstado().eval(
      RESERVAR_LUA,
      1,
      chaveContato(contactId),
      String(JANELA_CONTATO_MS),
      String(MAX_ENVIOS_CONTATO_24H),
    )) as [number, number];
    if (ok === 1) return { ok: true };
    return { ok: false, esperaMs: pttl > 0 ? pttl : JANELA_CONTATO_MS };
  } catch (e) {
    logger.warn({ contactId, err: e instanceof Error ? e.message : String(e) }, "[flow] limite por contato indisponível — liberando");
    return { ok: true };
  }
}

/** Devolve a reserva quando o envio NÃO saiu (ou foi adiado depois de reservar). */
export async function devolverEnvioAoContato(contactId: string): Promise<void> {
  try {
    await redisEstado().eval(DEVOLVER_LUA, 1, chaveContato(contactId), String(JANELA_CONTATO_MS));
  } catch {
    /* sem Redis: a janela expira sozinha */
  }
}

export type PoliticaDeReentrada = "never" | { cooldownHours: number } | null;

/** Política efetiva: a configurada no fluxo, ou o padrão por tipo de gatilho. */
export function politicaDeReentrada(triggerType: string, triggerConfig: unknown): PoliticaDeReentrada {
  const r = (triggerConfig as { reentry?: unknown } | null)?.reentry;
  if (r === "never") return "never";
  if (r && typeof r === "object" && typeof (r as { cooldownHours?: unknown }).cooldownHours === "number") {
    return { cooldownHours: Math.max(0, (r as { cooldownHours: number }).cooldownHours) };
  }
  if (r === "always") return null;
  return triggerType === "message_received" ? { cooldownHours: COOLDOWN_PADRAO_MENSAGEM_H } : null;
}

/**
 * Pode (re)inscrever pelo gatilho? Olha a ÚLTIMA inscrição do contato neste
 * fluxo (qualquer status) e, se o fluxo for `exclusivo`, as inscrições ativas
 * dele em OUTROS fluxos exclusivos. Roda no contexto do time.
 */
export const MOTIVO_OPT_OUT = "contato pediu para sair (opt-out)";

export async function podeReinscrever(input: {
  flowId: string;
  contactId: string;
  triggerType: string;
  triggerConfig: unknown;
  agora?: Date;
  /**
   * `relacionamentoStatus` já lido por quem chama (o `enrollByTrigger` lê uma
   * vez para todos os fluxos casados). `undefined` = ler aqui.
   */
  relacionamentoStatus?: string | null;
}): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const prisma = db();
  // Opt-out (N12): quem pediu para sair não entra em fluxo nenhum — antes, um
  // gatilho de tag ou manual ainda mandava mensagem a quem disse "pare".
  const status =
    input.relacionamentoStatus !== undefined
      ? input.relacionamentoStatus
      : (await prisma.contact.findUnique({ where: { id: input.contactId }, select: { relacionamentoStatus: true } }))
          ?.relacionamentoStatus;
  if (status === "opt_out") return { ok: false, motivo: MOTIVO_OPT_OUT };
  const politica = politicaDeReentrada(input.triggerType, input.triggerConfig);
  if (politica) {
    const ultima = await prisma.enrollment.findFirst({
      where: { flowId: input.flowId, contactId: input.contactId, paiId: null }, // ramos não contam para a reentrada
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (ultima) {
      if (politica === "never") return { ok: false, motivo: "reentrada desligada neste fluxo" };
      const desde = (input.agora ?? new Date()).getTime() - ultima.createdAt.getTime();
      if (desde < politica.cooldownHours * 3_600_000) {
        return { ok: false, motivo: `reentrada em cooldown (${politica.cooldownHours} h)` };
      }
    }
  }
  if ((input.triggerConfig as { exclusivo?: unknown } | null)?.exclusivo === true) {
    const outra = await prisma.enrollment.findFirst({
      where: {
        contactId: input.contactId,
        flowId: { not: input.flowId },
        status: { in: ["active", "waiting"] },
        flow: { triggerConfig: { path: ["exclusivo"], equals: true } },
      },
      select: { id: true },
    });
    if (outra) return { ok: false, motivo: "contato já está em outro fluxo exclusivo" };
  }
  return { ok: true };
}

/**
 * Inscrição passou do teto de passos (loop sem espera): encerra como `failed`
 * com o motivo no log do fluxo. Roda no contexto do time.
 */
export async function encerrarPorLoop(alvo: { enrollmentId: string; nodeId: string; round: number; jobId?: string | null }): Promise<void> {
  const prisma = db();
  const erro = `loop: a inscrição passou de ${FLOW_MAX_STEPS} passos e foi encerrada para não repetir envios`;
  await prisma.flowStepExecution
    .create({
      data: {
        enrollmentId: alvo.enrollmentId,
        nodeId: alvo.nodeId,
        round: alvo.round,
        jobId: alvo.jobId ?? null,
        status: "failed",
        error: erro,
        finishedAt: new Date(),
      } as never,
    })
    .catch(() => undefined); // retry do mesmo job: já registrado
  await prisma.enrollment.update({ where: { id: alvo.enrollmentId }, data: { status: "failed", nextRunAt: null } });
  logger.warn({ ...alvo }, "[flow] inscrição encerrada por loop");
}
