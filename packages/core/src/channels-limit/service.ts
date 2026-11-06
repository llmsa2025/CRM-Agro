import type { ChannelAccountStatus, Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { adiamentoParaProximoDia, configDoTimeComCache } from "../motor-do-dia/send-window";
import { redisEstado } from "../shared/redis-cache";
import { invalidarCache, lerOuCalcular } from "../shared/cache-curto";
import { DEFAULT_TZ, zonedParts } from "../motor-do-dia/tz";
import { requireCan } from "../auth/authz";
import { chaveDoEscopo } from "../tenancy/escopo";
import { escopoCanal } from "../conversations/escopo";

/**
 * Controle de ritmo por conta (Fase B da auditoria de escala). Teto de envios/dia por
 * ChannelAccount, com AQUECIMENTO (warmup) pela idade da conta, ADIAMENTO quando
 * estoura (em vez de queimar o número) e PAUSA automática por saúde.
 *
 * Tudo tenant-scoped via `db()` (roda dentro de runWithTeam, inclusive no
 * worker). O contador diário é uma row por (conta, dia-calendário do time).
 */

const DAY_MS = 86_400_000;

/**
 * Rampa de aquecimento: teto de envios/dia conforme os dias desde o início do
 * warmup (ou a criação da conta). Números conservadores estilo WhatsApp — um
 * número novo manda pouco e sobe aos poucos, como um humano faria.
 */
const WARMUP: { untilDay: number; limit: number }[] = [
  { untilDay: 3, limit: 20 },
  { untilDay: 7, limit: 50 },
  { untilDay: 14, limit: 100 },
  { untilDay: 30, limit: 200 },
];
const MATURE_LIMIT = 400;

/**
 * Rampa de E-MAIL (item 1.7, MF-15/INT-06). Antes o e-mail não tinha teto nem
 * aquecimento: um fluxo de 2 mil contatos saía no ritmo do limitador global e o
 * Gmail/Workspace suspendia a conta (`550 5.4.5 Daily sending quota exceeded`).
 */
const WARMUP_EMAIL: { untilDay: number; limit: number }[] = [
  { untilDay: 3, limit: 30 },
  { untilDay: 7, limit: 60 },
  { untilDay: 14, limit: 120 },
];
const MATURE_LIMIT_EMAIL = 300;

type AccountRate = {
  id: string;
  dailyLimit: number | null;
  warmupStartedAt: Date | null;
  paused: boolean;
  createdAt: Date;
  /** Canal da conta: e-mail tem rampa própria. Ausente = rampa do WhatsApp. */
  canal?: string;
  /** Pausa por QUEDA da conexão (item 1.6) vs manual: `disconnected` = queda. */
  status?: string;
  /** Quando a conexão caiu (null = não caiu, ou linha anterior à coluna). */
  desconectadaEm?: Date | null;
  updatedAt?: Date;
};

/**
 * Desde quando a conta está caída. `desconectadaEm` é gravado na queda e limpo
 * na volta (whatsapp-conexao). Conta que caiu ANTES da coluna existir (sem o
 * valor) cai no `updatedAt`, como era antes. Conta que não está `disconnected`
 * → null.
 */
export function quandoCaiu(acc: { status?: string; desconectadaEm?: Date | null; updatedAt?: Date }): Date | null {
  if (acc.status !== "disconnected") return null;
  return acc.desconectadaEm ?? acc.updatedAt ?? null;
}

/**
 * Quanto adiar um envio de conta pausada POR QUEDA (auditoria do #66). Antes
 * toda pausa ia para o próximo dia útil: o Baileys cai e volta sozinho em
 * segundos (restart 515, rede do VPS) e os passos daquele instante perdiam o
 * dia. Agora escalona pelo tempo desde a queda (`quandoCaiu`: a coluna
 * `desconectadaEm`; antes era o `updatedAt`, que andava com qualquer mudança da
 * conta e "rejuvenescia" a queda): logo depois, tenta de novo em ~10 min; até
 * 3 h, em ~45 min; queda longa, próximo dia (não gira o passo a cada 10 min).
 */
export function adiamentoPorQueda(caiuEm: Date | null | undefined, agora: Date): number | null {
  const desde = caiuEm ? agora.getTime() - caiuEm.getTime() : Infinity;
  const folga = Math.round(Math.random() * 5 * 60_000);
  if (desde < 30 * 60_000) return 10 * 60_000 + folga;
  if (desde < 3 * 3_600_000) return 45 * 60_000 + folga;
  return null; // queda longa: próximo dia útil
}

/** Dias completos desde o início do aquecimento (ou criação). */
function warmupDay(acc: AccountRate, now: Date): number {
  const base = acc.warmupStartedAt ?? acc.createdAt;
  return Math.max(0, Math.floor((now.getTime() - base.getTime()) / DAY_MS));
}

/** Teto diário efetivo: override manual, senão a rampa de warmup. */
export function effectiveDailyLimit(acc: AccountRate, now: Date = new Date()): number {
  if (acc.dailyLimit != null) return acc.dailyLimit;
  const d = warmupDay(acc, now);
  const email = acc.canal === "email";
  for (const step of email ? WARMUP_EMAIL : WARMUP) if (d < step.untilDay) return step.limit;
  return email ? MATURE_LIMIT_EMAIL : MATURE_LIMIT;
}

/** Chave do dia-calendário do time (Date em meia-noite UTC do dia local). */
function dayKey(now: Date, tz: string): Date {
  const p = zonedParts(now, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/** Fuso do time (TeamConfig, cache de 5 min — antes 1 consulta por envio). */
async function teamTz(): Promise<string> {
  const cfg = await configDoTimeComCache();
  return cfg.timezone || DEFAULT_TZ;
}

export type ConsumeResult =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: "paused" | "daily_cap"; retryAfterMs: number };

/**
 * Tenta consumir 1 envio da cota da conta HOJE, de forma atômica.
 *   - conta pausada → { allowed:false, reason:"paused" } (manual: dia seguinte;
 *     por queda da conexão: ~10 min / ~45 min / dia seguinte — adiamentoPorQueda).
 *   - cota estourada → { allowed:false, reason:"daily_cap" } (adia p/ o dia seguinte).
 *   - senão incrementa o contador e libera.
 *
 * A atomicidade vem do `updateMany` condicional (`sent < limit`): sob
 * concorrência do worker, só UMA transação consegue o incremento na borda.
 *
 * `opts.limite`: teto escolhido por quem envia (o "Limite por dia" da
 * campanha). Substitui o aquecimento e o teto da conta: decisão do dono
 * (29/10/2026), quem preenche o campo assume o risco do número.
 */
export async function consumeSendQuota(
  channelAccountId: string,
  now: Date = new Date(),
  opts: { limite?: number | null } = {},
): Promise<ConsumeResult> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  const acc = (await prisma.channelAccount.findUnique({
    where: { id: channelAccountId },
    select: {
      id: true,
      dailyLimit: true,
      warmupStartedAt: true,
      paused: true,
      createdAt: true,
      canal: true,
      status: true,
      desconectadaEm: true,
      updatedAt: true,
    },
  })) as AccountRate | null;
  if (!acc) return { allowed: true, remaining: 0 }; // conta some → não bloqueia o motor

  const tz = await teamTz();
  // Adiamento (pausa/teto): abertura da janela do próximo dia útil + jitter —
  // antes era 00:00 em ponto e o backlog saía em rajada (MF-05). Pausa por
  // QUEDA da conexão tenta de novo antes (ver adiamentoPorQueda).
  if (acc.paused) {
    const curto = acc.status === "disconnected" ? adiamentoPorQueda(quandoCaiu(acc), now) : null;
    return { allowed: false, reason: "paused", retryAfterMs: curto ?? (await adiamentoParaProximoDia(now)) };
  }

  const limit = opts.limite ?? effectiveDailyLimit(acc, now);
  const day = dayKey(now, tz);

  // garante a row do dia (sent=0) sem sobrescrever o contador existente. Com a
  // extensão de tenancy o upsert vira find+create: dois envios no 1º minuto do
  // dia criam juntos e um toma P2002 (MF-06) — a row já existe, então segue.
  try {
    await prisma.channelAccountUsage.upsert({
      where: { channelAccountId_day: { channelAccountId, day } },
      update: {},
      create: tenantData<Prisma.ChannelAccountUsageUncheckedCreateInput>({ channelAccountId, day, sent: 0 }),
    });
  } catch (e) {
    if (!(typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002")) throw e;
  }

  // incremento condicional: só passa se ainda houver cota
  const res = await prisma.channelAccountUsage.updateMany({
    where: { channelAccountId, day, sent: { lt: limit } },
    data: { sent: { increment: 1 } },
  });
  if (res.count === 1) {
    // Envios do dia mudaram: o bloco do menu (item 2.9) relê na próxima.
    if (acc.canal !== "email") await invalidarStatusWhatsApp(teamId);
    const row = await prisma.channelAccountUsage.findUnique({
      where: { channelAccountId_day: { channelAccountId, day } },
      select: { sent: true },
    });
    return { allowed: true, remaining: Math.max(0, limit - (row?.sent ?? limit)) };
  }
  return { allowed: false, reason: "daily_cap", retryAfterMs: await adiamentoParaProximoDia(now) };
}

/**
 * Esgota a cota de HOJE da conta (item 1.7): o provedor avisou que o limite
 * diário dele acabou (SMTP 452 / 5.4.5). Os próximos envios do dia adiam para a
 * abertura do próximo dia útil — e voltam sozinhos amanhã (uma pausa manual
 * ficaria parada até alguém despausar).
 */
export async function esgotarCotaDoDia(channelAccountId: string, now: Date = new Date()): Promise<void> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  const acc = (await prisma.channelAccount.findUnique({
    where: { id: channelAccountId },
    select: { id: true, dailyLimit: true, warmupStartedAt: true, paused: true, createdAt: true, canal: true },
  })) as AccountRate | null;
  if (!acc) return;
  const day = dayKey(now, await teamTz());
  const limit = effectiveDailyLimit(acc, now);
  const existe = await prisma.channelAccountUsage.updateMany({ where: { channelAccountId, day }, data: { sent: limit } });
  if (existe.count === 0) {
    await prisma.channelAccountUsage
      .create({ data: tenantData<Prisma.ChannelAccountUsageUncheckedCreateInput>({ channelAccountId, day, sent: limit }) })
      .catch(() => prisma.channelAccountUsage.updateMany({ where: { channelAccountId, day }, data: { sent: limit } }));
  }
  if (acc.canal !== "email") await invalidarStatusWhatsApp(teamId);
}

/**
 * Devolve 1 envio da cota do dia (item 1.2, MF-03): o envio foi contado mas
 * NÃO saiu (Evolution fora, 5xx, número inválido). Antes a cota sumia mesmo
 * sem mensagem enviada. Nunca desce de zero.
 */
export async function devolverCotaDeEnvio(channelAccountId: string, now: Date = new Date()): Promise<void> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  const day = dayKey(now, await teamTz());
  const { count } = await prisma.channelAccountUsage.updateMany({
    where: { channelAccountId, day, sent: { gt: 0 } },
    data: { sent: { decrement: 1 } },
  });
  if (count) await invalidarStatusWhatsApp(teamId);
}

/** Status de cota da conta (para a UI de canais). */
export async function getAccountRateStatus(channelAccountId: string, now: Date = new Date()) {
  const prisma = db();
  const acc = (await prisma.channelAccount.findUnique({
    where: { id: channelAccountId },
    select: {
      id: true,
      dailyLimit: true,
      warmupStartedAt: true,
      paused: true,
      createdAt: true,
      canal: true,
      status: true,
      desconectadaEm: true,
      updatedAt: true,
    },
  })) as AccountRate | null;
  if (!acc) return null;
  const tz = await teamTz();
  const limit = effectiveDailyLimit(acc, now);
  const row = await prisma.channelAccountUsage.findUnique({
    where: { channelAccountId_day: { channelAccountId, day: dayKey(now, tz) } },
    select: { sent: true },
  });
  const sent = row?.sent ?? 0;
  const caiu = quandoCaiu(acc);
  return {
    limit,
    sent,
    remaining: Math.max(0, limit - sent),
    paused: acc.paused,
    warmupDay: warmupDay(acc, now),
    /** ISO de quando a conexão caiu; null = não está caída. */
    desconectadaEm: caiu ? caiu.toISOString() : null,
  };
}

// ─── Bloco do WhatsApp no menu (item 2.9, N11) ──────────────────────────────

export type PrimaryWhatsAppStatus = {
  channelAccountId: string;
  label: string;
  status: ChannelAccountStatus;
  paused: boolean;
  sent: number;
  limit: number;
  remaining: number;
  warmupDay: number;
  /** ISO de quando a conexão caiu ("desconectado há 2 h"); null = não está caída. */
  desconectadaEm: string | null;
};

/** 60 s: o menu é renderizado em toda página; a invalidação cobre as mudanças. */
export const WA_STATUS_TTL_S = 60;
const chaveStatusWhatsApp = (teamId: string) => `wa:status:${teamId}`;

/**
 * Resumo do WhatsApp principal do time para o menu: envios de hoje, teto, dia
 * de aquecimento, pausa e estado da conexão. Antes o menu chamava
 * `getAccountRateStatus` a cada página (conta + fuso + uso = 3 consultas);
 * agora é 1 consulta (conta + uso do dia via select aninhado) com cache Redis de
 * 60 s por time e escopo (`wa:status:<teamId>:<tudo|userId>`), invalidado
 * quando os envios do dia, a pausa ou a conexão mudam.
 *
 * Principal = a conta WhatsApp conectada mais antiga ENTRE as que a pessoa vê
 * (F3); sem nenhuma conectada, a mais antiga (para o menu mostrar
 * "desconectado" em vez de sumir). Sem conta WhatsApp visível → null.
 */
export async function getPrimaryWhatsAppStatus(now: Date = new Date()): Promise<PrimaryWhatsAppStatus | null> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  // Escopo por dono (auditoria de isolamento 09/2026): o bloco do menu mostrava
  // a TODOS o número principal do time (nome, envios do dia e o id da conta do
  // master). Agora é o principal ENTRE os números que a pessoa vê (F3).
  const canal = escopoCanal();
  const calcular = async (): Promise<PrimaryWhatsAppStatus | null> => {
    const day = dayKey(now, await teamTz()); // fuso do time: cache de 5 min em memória
    const contas = await prisma.channelAccount.findMany({
      where: { AND: [{ canal: "whatsapp" }, canal] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
      select: {
        id: true,
        label: true,
        status: true,
        paused: true,
        dailyLimit: true,
        warmupStartedAt: true,
        createdAt: true,
        canal: true,
        desconectadaEm: true,
        updatedAt: true,
        usage: { where: { day }, select: { sent: true }, take: 1 },
      },
    });
    const conta = contas.find((c) => c.status === "connected") ?? contas[0];
    if (!conta) return null;
    const limit = effectiveDailyLimit(conta, now);
    const sent = conta.usage[0]?.sent ?? 0;
    return {
      channelAccountId: conta.id,
      label: conta.label,
      status: conta.status,
      paused: conta.paused,
      sent,
      limit,
      remaining: Math.max(0, limit - sent),
      warmupDay: warmupDay(conta, now),
      desconectadaEm: quandoCaiu(conta)?.toISOString() ?? null,
    };
  };
  // Sem time no contexto a extensão não devolve nada (fail-closed); nada a cachear.
  if (!teamId) return calcular();
  // Uma chave por escopo ("tudo" ou a pessoa, pelo "ver tudo" de Conversas —
  // a tela dos números); a geração continua por time
  // (`invalidarStatusWhatsApp` derruba todas de uma vez).
  const escopo = chaveDoEscopo("conversas");
  return lerOuCalcular(`${chaveStatusWhatsApp(teamId)}:${escopo}`, WA_STATUS_TTL_S, calcular, chaveStatusWhatsApp(teamId));
}

/**
 * Invalida o bloco do menu do time (chamar DEPOIS de gravar a mudança). Sem
 * `teamId`, usa o do contexto. Best-effort: sem Redis, expira em 60 s.
 */
export async function invalidarStatusWhatsApp(teamId: string | null = getCurrentTeamId()): Promise<void> {
  if (teamId) await invalidarCache(chaveStatusWhatsApp(teamId));
}

/** Pausa/despausa uma conta manualmente (ou pelo monitor de saúde). */
export async function setAccountPaused(channelAccountId: string, paused: boolean) {
  requireCan("integrations.manage");
  const prisma = db();
  const teamId = getCurrentTeamId();
  await prisma.channelAccount.update({ where: { id: channelAccountId }, data: { paused } });
  await invalidarStatusWhatsApp(teamId);
}

// Monitor de saúde: janela e limiares.
const HEALTH_WINDOW_MS = 60 * 60 * 1000; // última hora
const HEALTH_MIN_VOLUME = 10; // só avalia com volume mínimo
const HEALTH_MAX_FAIL_RATE = 0.3; // > 30% de falha → pausa

/**
 * Avalia a saúde recente da conta pelos acks de saída (Message.status=failed ou
 * errorCode preenchido) e PAUSA automaticamente se a taxa de erro passar do
 * limiar. Chamado quando um ack de erro chega pelo webhook. Retorna se pausou.
 */
export async function checkAndMaybePauseAccount(channelAccountId: string, now: Date = new Date()): Promise<boolean> {
  const prisma = db();
  const since = new Date(now.getTime() - HEALTH_WINDOW_MS);
  const where: Prisma.MessageWhereInput = {
    direcao: "out",
    createdAt: { gt: since },
    conversation: { channelAccountId },
  };
  const [total, falhas] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.count({ where: { ...where, OR: [{ status: "failed" }, { errorCode: { not: null } }] } }),
  ]);
  if (total < HEALTH_MIN_VOLUME) return false;
  if (falhas / total < HEALTH_MAX_FAIL_RATE) return false;
  await setAccountPaused(channelAccountId, true);
  return true;
}

/** Intervalo mínimo entre e-mails automáticos da MESMA conta (item 1.7): 30–90 s. */
export const ESPACO_EMAIL_MIN_S = 30;
export const ESPACO_EMAIL_MAX_S = 90;

/**
 * Espaçamento entre e-mails da conta: reserva o "próximo horário livre" com
 * `SET NX PX` (atômico — dois jobs não passam juntos). Ocupado → devolve quanto
 * esperar. Redis fora → libera (a fila do motor também depende dele).
 */
export async function reservarEspacoDeEmail(
  channelAccountId: string,
  aleatorio: () => number = Math.random,
): Promise<{ ok: true } | { ok: false; esperaMs: number }> {
  try {
    const r = redisEstado();
    const k = `email:espaco:${channelAccountId}`;
    const gapMs = Math.round((ESPACO_EMAIL_MIN_S + aleatorio() * (ESPACO_EMAIL_MAX_S - ESPACO_EMAIL_MIN_S)) * 1000);
    const livre = await r.set(k, "1", "PX", gapMs, "NX");
    if (livre === "OK") return { ok: true };
    const pttl = await r.pttl(k);
    return { ok: false, esperaMs: Math.max(1000, pttl) + Math.round(aleatorio() * 15_000) };
  } catch {
    return { ok: true };
  }
}
