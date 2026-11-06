import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "@crmagro/config";
import { basePrisma, db, getCurrentTeamId, tenantData } from "@crmagro/db";
import {
  createEvolutionInstance,
  deleteEvolutionInstance,
  getEvolutionQR,
  setEvolutionWebhook,
  verifyEvolutionInstance,
} from "@crmagro/channels";
import { ForbiddenError, requireCan } from "../auth/authz";
import { tokenDoWebhookDaInstancia, WEBHOOK_TOKEN_HEADER } from "./whatsapp-webhook-token";
import { redisEstado } from "../shared/redis-cache";
import { logger } from "../logger/index";
import { invalidarStatusWhatsApp } from "../channels-limit/service";
import { agendarHistoricoWhatsApp } from "./whatsapp-historico";

import { donoPadrao } from "../tenancy/escopo";
/**
 * Onboarding de WhatsApp (QR da Evolution) amarrado ao TIME — auditoria S4/INT-18.
 *
 * A Evolution é uma só, com uma apikey global: o nome da instância era o único
 * separador entre times, e vinha do cliente. Um admin de qualquer time podia
 * confirmar a instância de outro (e enviar pelo número dele) ou cancelar
 * (derrubar a sessão WhatsApp dele).
 *
 * Agora:
 * - `start` cria a instância e grava no Redis `wa:onboard:<instância> = teamId`
 *   (15 min) + índices para limite e GC;
 * - `check`/`cancel`/`confirm` só aceitam instância pendente DO time da sessão;
 * - `confirm` grava `ChannelAccount.externalId` (único por provedor);
 * - limites: 2 pendentes e 5 conectadas por time;
 * - GC (worker primário): pendente há mais de 15 min é apagada na Evolution.
 *
 * O Redis aqui é ESTADO de segurança: sem Redis, o onboarding falha (fail-closed).
 */

export const WA_ONBOARD_TTL_MS = 15 * 60 * 1000;
export const WA_MAX_PENDENTES_POR_TIME = 2;
export const WA_MAX_CONECTADAS_POR_TIME = 5;

const chaveInstancia = (instance: string) => `wa:onboard:${instance}`;
const chaveDoTime = (teamId: string) => `wa:onboard:time:${teamId}`;
const CHAVE_GLOBAL = "wa:onboard:pendentes";

function evolution() {
  return { apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20) || "conta"
  );
}

function timeAtual(): string {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new ForbiddenError();
  return teamId;
}

/** Instância precisa estar pendente E ser do time da sessão. Senão: Forbidden. */
async function exigirPendenteDoTime(instance: string): Promise<string> {
  const teamId = timeAtual();
  if (!instance) throw new ForbiddenError("instância inválida");
  const dono = await redisEstado().get(chaveInstancia(instance));
  if (dono !== teamId) throw new ForbiddenError("instância não pertence a este time (ou o QR expirou)");
  return teamId;
}

async function esquecerPendente(teamId: string, instance: string): Promise<void> {
  await redisEstado()
    .multi()
    .del(chaveInstancia(instance))
    .zrem(chaveDoTime(teamId), instance)
    .zrem(CHAVE_GLOBAL, `${teamId}|${instance}`)
    .exec();
}

export type WaStartResult =
  | { ok: true; instance: string; qrBase64: string | null; alreadyConnected: boolean }
  | { ok: false; error: string };

/** Cria a instância na Evolution, registra como pendente do time e devolve o QR. */
export async function startWhatsAppOnboarding(input: { label: string }): Promise<WaStartResult> {
  requireCan("integrations.manage");
  const prisma = db(); // eager (convenção §12: db() antes de qualquer await)
  const teamId = timeAtual();
  const label = input.label?.trim();
  if (!label) return { ok: false, error: "nome obrigatório" };

  const agora = Date.now();
  const redis = redisEstado();
  await redis.zremrangebyscore(chaveDoTime(teamId), 0, agora - WA_ONBOARD_TTL_MS);
  if ((await redis.zcard(chaveDoTime(teamId))) >= WA_MAX_PENDENTES_POR_TIME) {
    return { ok: false, error: `já há ${WA_MAX_PENDENTES_POR_TIME} conexões aguardando QR. Conclua ou cancele uma delas` };
  }
  const conectadas = await prisma.channelAccount.count({ where: { canal: "whatsapp", provider: "evolution" } });
  if (conectadas >= WA_MAX_CONECTADAS_POR_TIME) {
    return { ok: false, error: `limite de ${WA_MAX_CONECTADAS_POR_TIME} números de WhatsApp por time` };
  }

  const instance = `${slugify(label)}-${randomUUID().slice(0, 8)}`;
  // Registra ANTES de criar na Evolution: se algo falhar no meio, o GC limpa.
  await redis
    .multi()
    .set(chaveInstancia(instance), teamId, "PX", WA_ONBOARD_TTL_MS)
    .zadd(chaveDoTime(teamId), agora, instance)
    .pexpire(chaveDoTime(teamId), WA_ONBOARD_TTL_MS * 2)
    .zadd(CHAVE_GLOBAL, agora, `${teamId}|${instance}`)
    .exec();

  const { apiUrl, apiKey } = evolution();
  const created = await createEvolutionInstance({ apiUrl, apiKey, instance });
  if (!created.ok) return { ok: false, error: created.error ?? "falha ao criar a instância" };

  // Webhook de entrada (Evolution → app). Sem APP_PUBLIC_URL, pula (manual).
  // Token DA INSTÂNCIA no header, nunca na URL (item 3.7, S18).
  if (env.APP_PUBLIC_URL) {
    const segredo = env.WHATSAPP_WEBHOOK_TOKEN;
    const url = `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/api/webhooks/whatsapp`;
    await setEvolutionWebhook({
      apiUrl,
      apiKey,
      instance,
      url,
      ...(segredo ? { headers: { [WEBHOOK_TOKEN_HEADER]: tokenDoWebhookDaInstancia(instance, segredo) } } : {}),
    });
  }

  const qr = await getEvolutionQR({ apiUrl, apiKey, instance });
  if (!qr.ok) return { ok: false, error: qr.error ?? "QR indisponível" };
  if (qr.state === "open") return { ok: true, instance, qrBase64: null, alreadyConnected: true };
  if (!qr.qrBase64) return { ok: false, error: "QR indisponível. A instância pode já estar conectada." };
  return { ok: true, instance, qrBase64: qr.qrBase64, alreadyConnected: false };
}

/** Estado da instância pendente (o modal consulta até virar "open"). */
export async function checkWhatsAppOnboarding(
  instance: string,
): Promise<{ ok: boolean; state: string | null; connected: boolean; error?: string }> {
  requireCan("integrations.manage");
  await exigirPendenteDoTime(instance);
  const v = await verifyEvolutionInstance({ ...evolution(), instance });
  return { ok: v.ok, state: v.state, connected: v.ok, ...(v.error ? { error: v.error } : {}) };
}

/** Desiste do onboarding: apaga a instância na Evolution (só a do próprio time). */
export async function cancelWhatsAppOnboarding(instance: string): Promise<{ ok: boolean; error?: string }> {
  requireCan("integrations.manage");
  const teamId = await exigirPendenteDoTime(instance);
  const r = await deleteEvolutionInstance({ ...evolution(), instance });
  await esquecerPendente(teamId, instance);
  return r;
}

/** QR escaneado: confere o estado e grava a conta com `externalId` = instância. */
export async function confirmWhatsAppOnboarding(input: {
  label: string;
  number?: string | null;
  instance: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  requireCan("integrations.manage");
  const prisma = db(); // eager (convenção §12)
  const teamId = await exigirPendenteDoTime(input.instance);
  const v = await verifyEvolutionInstance({ ...evolution(), instance: input.instance });
  if (!v.ok) return { ok: false, error: v.error ?? `instância não conectada (estado: ${v.state ?? "?"})` };
  try {
    const account = await prisma.channelAccount.create({
      // Só instance/number: apiUrl/apiKey vêm do env no factory.
      data: tenantData<Prisma.ChannelAccountUncheckedCreateInput>({
        canal: "whatsapp",
        label: input.label,
        ownerId: donoPadrao(), // F3: quem conectou (vê as conversas; + master/admin/"ver tudo")
        provider: "evolution",
        externalId: input.instance,
        credentials: { instance: input.instance, number: input.number ?? null },
        status: "connected",
      }),
      select: { id: true },
    });
    await esquecerPendente(teamId, input.instance);
    await invalidarStatusWhatsApp(teamId); // conta nova pode virar a principal do menu (item 2.9)
    // Conta já salva: falha da fila não transforma a confirmação em falha nem
    // deixa o modal apagar a instância. A varredura do worker retenta no boot.
    await agendarHistoricoWhatsApp({ accountId: account.id, teamId, instance: input.instance }).catch((e) => {
      logger.warn({ accountId: account.id, err: e instanceof Error ? e.message : String(e) }, "[wa-history] agendamento pendente para a varredura");
    });
    return { ok: true, id: account.id };
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      return { ok: false, error: "esta instância já está ligada a uma conta" };
    }
    throw e;
  }
}

/**
 * GC (worker primário, a cada 15 min): instância pendente há mais de 15 min é
 * apagada na Evolution — a não ser que tenha virado conta (confirm concorrente).
 */
export async function gcPendingWhatsAppOnboardings(agora = Date.now()): Promise<{ apagadas: number }> {
  const redis = redisEstado();
  const vencidas = await redis.zrangebyscore(CHAVE_GLOBAL, 0, agora - WA_ONBOARD_TTL_MS);
  let apagadas = 0;
  for (const membro of vencidas) {
    const [teamId, instance] = membro.split("|") as [string, string];
    const virouConta = await basePrisma.channelAccount.findUnique({
      where: { provider_externalId: { provider: "evolution", externalId: instance } },
      select: { id: true },
    });
    if (!virouConta) {
      const r = await deleteEvolutionInstance({ ...evolution(), instance });
      if (!r.ok) logger.warn({ instance, err: r.error }, "[wa-onboard] GC não conseguiu apagar a instância");
      else apagadas++;
    }
    await esquecerPendente(teamId, instance);
  }
  return { apagadas };
}
