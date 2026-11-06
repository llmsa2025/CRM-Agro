import type { CallStatus, Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { canCallNow } from "../motor-do-dia/business-hours";
import { getTeamConfig, getTeamConfigComCache, toBusinessHoursOptions } from "../motor-do-dia/team-config";
import { calcRemainingTouches } from "../motor-do-dia/touch-budget";
import { DEFAULT_TZ, zonedParts, zonedTimeToUtc } from "../motor-do-dia/tz";
import { CallNotFound, CallValidationError } from "./errors";
import { requireCan } from "../auth/authz";
import { registrarResultado, STATUS_DOS_RESULTADOS_NOVOS, textoDoResultado } from "./resultado";
import type { CallOutcome } from "./schema";

import { donoPadrao } from "../tenancy/escopo";
import { escopoLigacao } from "./escopo";
import { escopoDoContato } from "../contacts/escopo";
/**
 * Discador progressivo — a Fase 1 do módulo de Ligação (Fase 4 do roadmap).
 *
 * O SDR usa computador + headset para ligar via Voopi (R$0,08/min fixo,
 * R$0,35/min celular). O discador faz ~200 ligações/dia.
 *
 * **Horário comercial e feriados são CONFIGURÁVEIS** (não fixos).
 * O usuário prospecta das 5h às 7h da manhã — `respectBusinessHours=false`
 * (default) permite ligar em qualquer horário. Se `true`, respeita
 * `business-hours.ts` (`canCallNow()`).
 *
 * Puros (só @crmagro/db). Chamam `db()` no início de cada função (leitura eager
 * do teamId via ALS — AGENTS.md). Nunca recebem teamId por parâmetro.
 */

// ─── Tipos ────────────────────────────────────────────────────────────

/** Resultado possível de uma ligação no discador (o mesmo do pop-up — produto §D). */
export type DialerOutcome = CallOutcome;

/** Sessão do discador — representa uma jornada de ligações do dia. */
export interface DialerSession {
  id: string;
  date: Date;
  respectBusinessHours: boolean;
  total: number;
  answered: number;
  noAnswer: number;
  busy: number;
  skipped: number;
  remaining: number;
}

/** Estatísticas da sessão do discador. */
export interface DialerStats {
  total: number;
  answered: number;
  noAnswer: number;
  busy: number;
  skipped: number;
  remaining: number;
  avgDurationSec: number;
}

/** Próximo contato a ligar — informação que o SDR vê no card do discador. */
export interface DialerSlot {
  callId: string;
  contactId: string;
  contactName: string;
  phoneNumber: string;
  empresa: string | null;
  cargo: string | null;
  observacoes: string | null;
  priority: "alta" | "media" | "baixa";
  touchCount: number;
}

// ─── Sessão em memória (não persiste — recalcula das Calls do dia) ─────

/**
 * A sessão é um conceito lógico: todas as Calls de hoje com provider
 * "voopi" ou "manual" e direction "outbound". Stats são calculadas
 * dinamicamente das Calls — não há model DialerSession no Prisma (evita
 * migration e mantém a fonte de verdade nas Calls).
 */

const sessions = new Map<string, { respectBusinessHours: boolean }>();

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * O dia de hoje no FUSO DO TIME (`TeamConfig.timezone`, padrão America/Sao_Paulo),
 * o mesmo do Painel: o instante UTC das 00:00 desse fuso (`inicio`) e a data
 * "YYYY-MM-DD" dele (`chave`). Antes era o fuso do servidor (UTC em produção):
 * depois das 21h de Brasília o "hoje" do discador já era o dia seguinte e a
 * ligação das 19h sumia do placar. A config vem do cache de 5 min por time
 * (`getTeamConfigComCache`, que lê o teamId do ALS na hora da chamada).
 */
async function diaDoTime(agora = new Date()): Promise<{ inicio: Date; chave: string; tz: string }> {
  const tz = (await getTeamConfigComCache()).timezone || DEFAULT_TZ;
  const { year, month, day } = zonedParts(agora, tz);
  return {
    tz,
    inicio: zonedTimeToUtc(year, month, day, 0, 0, tz),
    chave: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Início do dia atual (00:00) no fuso do time. */
async function startOfToday(): Promise<Date> {
  return (await diaDoTime()).inicio;
}

/** Mapa de outcome → CallStatus do Prisma. */
const OUTCOME_TO_STATUS: Record<DialerOutcome, "answered" | "no_answer" | "busy" | "failed" | "completed"> = {
  answered: "answered",
  no_answer: "no_answer",
  busy: "busy",
  skip: "completed",
  ...STATUS_DOS_RESULTADOS_NOVOS,
};

// ─── Placar do dia ────────────────────────────────────────────────────

/** O que o placar lê de cada ligação do dia. */
export type LinhaDoPlacar = {
  status: CallStatus;
  /** `Call.outcome`: o resultado marcado. Null = sorteada, ainda sem resultado. */
  outcome: DialerOutcome | null;
  durationSeconds: number | null;
};

/**
 * Conta o placar a partir das ligações do dia (pura, sem banco).
 *
 *  - `answered` = resultado `answered`; `skipped` = resultado `skip`.
 *  - `total` = ligações com resultado diferente de `skip`. Pular não é ligar, e
 *    a sorteada que ainda não tem resultado também não conta.
 *  - `noAnswer` e `busy` seguem o `status` (caixa postal vira `no_answer`).
 *  - `remaining` = sorteadas sem resultado (`scheduled` ou `ringing`).
 *
 * Antes o "pular" gravava `completed` e `answered` somava `answered` e
 * `completed`: cada pulo virava uma atendida.
 */
export function contarPlacar(calls: readonly LinhaDoPlacar[]): DialerStats {
  let total = 0;
  let answered = 0;
  let noAnswer = 0;
  let busy = 0;
  let skipped = 0;
  let remaining = 0;
  let somaDuracoes = 0;
  let comDuracao = 0;

  for (const c of calls) {
    if (c.outcome === "skip") skipped++;
    else if (c.outcome !== null) total++;
    if (c.outcome === "answered") answered++;
    if (c.status === "no_answer") noAnswer++;
    if (c.status === "busy") busy++;
    if (c.status === "scheduled" || c.status === "ringing") remaining++;
    if (c.durationSeconds != null) {
      somaDuracoes += c.durationSeconds;
      comDuracao++;
    }
  }

  return {
    total,
    answered,
    noAnswer,
    busy,
    skipped,
    remaining,
    avgDurationSec: comDuracao > 0 ? Math.round(somaDuracoes / comDuracao) : 0,
  };
}

/**
 * O placar do discador no dia de hoje (fuso do time), só das ligações de quem
 * está logado (`escopoLigacao`: master, admin e quem tem "ver tudo" em Ligações
 * veem as do time). É a conta única da sessão (`startDialerSession`) e das
 * estatísticas (`getDialerStats`). O Discador por telefonia (F2-22) continua
 * usando esta função: o fuso do time e a leitura do resultado ficam.
 */
export async function placarDoDia(): Promise<DialerStats> {
  const prisma = db();
  const escopo = escopoLigacao(); // lê o ator do ALS antes de qualquer await
  const todayStart = await startOfToday();

  const calls = await prisma.call.findMany({
    where: {
      direction: "outbound",
      provider: { in: ["voopi", "manual"] },
      createdAt: { gte: todayStart },
      AND: [escopo], // F3: a sessão de quem liga
    },
    select: {
      status: true,
      outcome: true,
      durationSeconds: true,
    },
  });

  return contarPlacar(calls);
}

// ─── Funções públicas ─────────────────────────────────────────────────

/**
 * Inicia (ou recupera) a sessão do discador para o dia atual.
 *
 * Se já existe uma sessão hoje, retorna os stats acumulados.
 * Se `respectBusinessHours=true`, o discador só permite ligar dentro do
 * horário comercial configurado em `business-hours.ts`.
 */
export async function startDialerSession(
  opts?: { respectBusinessHours?: boolean },
): Promise<DialerSession> {
  requireCan("calls.write");
  const respectBusinessHours = opts?.respectBusinessHours ?? false;
  // As duas começam antes de qualquer await (o ALS do time é lido na hora).
  const [dia, placar] = await Promise.all([diaDoTime(), placarDoDia()]);
  const sessionId = `dialer-${dia.chave}`;
  const { total, answered, noAnswer, busy, skipped, remaining } = placar;

  sessions.set(sessionId, { respectBusinessHours });

  return {
    id: sessionId,
    date: new Date(),
    respectBusinessHours,
    total,
    answered,
    noAnswer,
    busy,
    skipped,
    remaining,
  };
}

/**
 * Pega o próximo contato a ligar — prioriza contatos com menos toques
 * e maior prioridade (usando `calcRemainingTouches` do motor do dia).
 *
 * Se o toggle `respectBusinessHours` da sessão está ligado, aplica o gate de
 * horário comercial **configurável do time** (TeamConfig): janela, dias úteis,
 * feriados e fuso vêm da config, não mais chumbados. Fora dessa janela retorna
 * `null` (não pode ligar agora). Toggle desligado (default) libera sempre.
 *
 * Cria uma Call com status `scheduled` e retorna o slot para o SDR.
 */
export async function getNextDialerSlot(): Promise<DialerSlot | null> {
  requireCan("calls.write");
  const prisma = db();
  const { inicio: todayStart, chave, tz } = await diaDoTime();
  const session = sessions.get(`dialer-${chave}`);

  // O toggle da sessão decide SE o gate roda nesta sessão; as regras (janela,
  // dias, feriados, fuso) vêm do TeamConfig. `respectBusinessHours` é forçado
  // true porque o toggle já decidiu "respeitar o horário".
  if (session?.respectBusinessHours) {
    const cfg = await getTeamConfig();
    const opts = { ...toBusinessHoursOptions(cfg), respectBusinessHours: true };
    if (!canCallNow(new Date(), opts)) {
      return null;
    }
  }

  // Busca contatos que ainda não foram tocados por ligação hoje.
  const callsToday = await prisma.call.findMany({
    where: {
      direction: "outbound",
      provider: { in: ["voopi", "manual"] },
      createdAt: { gte: todayStart },
    },
    select: { contactId: true },
  });

  const calledContactIds = [...new Set(callsToday.map((c) => c.contactId))];

  // Próximo contato: não chamado hoje, com telefone VÁLIDO (via
  // ChannelIdentifier — número dado como errado não volta, produto §D),
  // ordenado por prioridade.
  const contact = await prisma.contact.findFirst({
    where: {
      AND: [escopoDoContato({ escrita: true })], // F3: o discador passa pelos contatos de quem liga
      id: { notIn: calledContactIds },
      identifiers: {
        some: { canal: "whatsapp", invalido: false },
      },
    },
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      nome: true,
      empresa: true,
      cargo: true,
      tags: true,
      identifiers: {
        where: { canal: "whatsapp", invalido: false },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { valor: true },
        take: 1,
      },
      activities: {
        where: { tipo: "call" },
        select: { id: true },
        take: 20,
      },
    },
  });

  if (!contact) {
    return null;
  }

  // Calcula prioridade baseada no touch budget.
  const touchBudget = await calcRemainingTouches(tz);
  const touchCount = contact.activities.length;
  const priority =
    touchCount === 0 ? "alta" : touchBudget.restantes > 0 ? "media" : "baixa";

  const phoneNumber = contact.identifiers[0]?.valor ?? "";

  // Cria a Call (status scheduled) para rastreabilidade.
  const call = await prisma.call.create({
    data: tenantData<Prisma.CallUncheckedCreateInput>({
      contactId: contact.id,
      phoneNumber,
      direction: "outbound",
      userId: donoPadrao(), // F3: quem ligou
      status: "scheduled",
      provider: "manual",
    }),
  });

  return {
    callId: call.id,
    contactId: contact.id,
    contactName: contact.nome,
    phoneNumber,
    empresa: contact.empresa,
    cargo: contact.cargo,
    observacoes: null,
    priority,
    touchCount,
  };
}

/**
 * Registra o resultado de uma ligação no discador.
 *
 * Atualiza o status da Call e cria uma Activity de rastreabilidade.
 * Se o resultado for "answered" ou "completed", registra duração se informada.
 * Caixa postal e número errado têm os mesmos efeitos do pop-up (`resultado.ts`).
 * "Pular" não cria Activity: não é ligação nem toque. O resultado fica na Call,
 * que é de onde o placar lê (`placarDoDia`).
 */
export async function markCallOutcome(
  callId: string,
  outcome: DialerOutcome,
  opts?: { durationSec?: number; notes?: string; agora?: Date },
): Promise<void> {
  requireCan("calls.write");
  const prisma = db();

  const call = await prisma.call.findFirst({
    where: { AND: [{ id: callId }, escopoLigacao({ escrita: true })] },
    select: { id: true, contactId: true, status: true, phoneNumber: true, provider: true, contact: { select: { nome: true } } },
  });

  if (!call) {
    throw new CallNotFound(callId);
  }

  // Ligação da Voopi: status, horários e duração vêm do webhook (o `answered`/
  // `completed` dela é o real, não um resultado já marcado). O vendedor só
  // marca o resultado — e fecha o status se o webhook não veio.
  const daVoopi = call.provider === "voopi";
  if (!daVoopi && (call.status === "answered" || call.status === "completed")) {
    throw new CallValidationError(
      `Call ${callId} já foi finalizada com status "${call.status}".`,
    );
  }

  const newStatus = OUTCOME_TO_STATUS[outcome];
  const now = opts?.agora ?? new Date();
  // Calendário do time para o retorno da caixa postal — lido fora da transação.
  const cfg = outcome === "voicemail" ? await getTeamConfig() : null;

  await prisma.$transaction(async (tx) => {
    await tx.call.update({
      where: { id: callId },
      data: {
        ...(daVoopi
          ? {}
          : {
              status: newStatus,
              ...(outcome === "answered"
                ? { startedAt: now, endedAt: now, durationSeconds: opts?.durationSec ?? 0 }
                : {}),
            }),
        ...(opts?.notes ? { notes: opts.notes } : {}),
      },
    });
    if (daVoopi) {
      await tx.call.updateMany({ where: { id: callId, status: { in: ["scheduled", "ringing"] } }, data: { status: newStatus } });
    }
    const ef = await registrarResultado(tx, call, outcome, { agora: now, cfg, contatoNome: call.contact.nome });

    // Pular não é ligação nem toque: o resultado já ficou na Call (o placar lê de lá).
    if (outcome === "skip") return;

    await tx.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId: call.contactId,
        tipo: "call",
        direcao: "out",
        conteudo: textoDoResultado(outcome),
        meta: {
          callId,
          outcome,
          durationSec: opts?.durationSec ?? 0,
          ...(ef.retorno ? { retornoAppointmentId: ef.retorno.appointmentId } : {}),
        },
      }),
    });
  });
}

/**
 * Retorna estatísticas da sessão do discador para o dia atual.
 * Calcula dinamicamente das Calls — não depende de sessão em memória.
 */
export async function getDialerStats(): Promise<DialerStats> {
  return placarDoDia();
}
