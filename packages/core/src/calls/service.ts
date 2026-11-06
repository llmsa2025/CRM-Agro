import type { Prisma, CallDirection, CallStatus } from "@prisma/client";
import { db, getCurrentTeamId, tenantData, basePrisma, runAsSystem } from "@crmagro/db";
import { ondeBuscaDeIdentificador } from "../contacts/identificadores-cifra";
import { z } from "zod";
import { normalizePhone, phoneVariants, resultadoDoEventoVoopi, type VoopiWebhookEvent } from "@crmagro/channels";
import { primaryTelefone, primaryEmail } from "../contacts/identifiers";
import { publishRealtime } from "../events/redis-bus";
import { applyCursor, buildResult, type CursorPaginationResult } from "../shared/pagination";
import { CallNotFound, CallValidationError } from "./errors";
import { gravacaoPermitida } from "./recording-url";
import { logger } from "../logger/index";
import { scheduleTranscription } from "./transcription-queue";
import { assertOwned, assertOwnedIfPresent, OwnedNotFound } from "../tenancy/assert-owned";
import {
  finishManualCallSchema,
  type AnotarLigacaoApiInput,
  type CallOutcome,
  type CreateCallInput,
  type FinishManualCallInput,
  type UpdateCallStatusInput,
  type UpdateCallTranscriptionInput,
} from "./schema";
import { requireCan } from "../auth/authz";
import { getTeamConfig } from "../motor-do-dia/team-config";
import {
  registrarResultado,
  STATUS_DOS_RESULTADOS_NOVOS,
  textoDoResultado,
  type EfeitosDoResultado,
} from "./resultado";

import { donoPadrao } from "../tenancy/escopo";
import { quemAge, recusarSeDeOutro, responsavelObrigatorio } from "../contacts/responsavel";
import { escopoLigacao } from "./escopo";
import { escopoDoContato } from "../contacts/escopo";
import { escopoNegocio } from "../funnels/escopo";
/**
 * Serviços de ligação (Call). Puros (só @crmagro/db). Chamam `db()` no início de
 * cada função (leitura eager do teamId — ver @crmagro/db/client). O teamId NUNCA
 * é parâmetro manual: vem do AsyncLocalStorage e é injetado em toda query pela
 * extensão de tenancy (§12). Logo, toda função aqui roda DENTRO de
 * `runWithTeam`/`runAsDev`, e `db()` é chamado antes de qualquer await.
 *
 * A row nasce leve (scheduled) em `createCall`; o webhook do provider realimenta
 * status/timestamps/duração em `updateCallStatus`, e o worker preenche
 * transcrição/resumo/áudio em `updateCallTranscription`.
 *
 * Esses três são INTERNOS: nenhum arquivo de `apps/` os importa (catraca
 * `escritores.catraca.test.ts`, F1A-08). A API HTTP só anota: `anotarCamposDaLigacao`.
 */

/** Qual a direção da Activity (in|out) segundo a direção da ligação. */
function activityDirecao(direction: CallDirection): "out" | "in" {
  return direction === "outbound" ? "out" : "in";
}

/**
 * Garante que o `contactId` existe no escopo do time atual. A FK de Call para
 * Contact é só por `id` (sem composite teamId), então sem isto uma ligação do
 * time A poderia referenciar um contato do time B e vazar na linha do tempo +
 * no `include: { contact }`. Fail-closed: a extensão injeta `teamId` no where
 * e o escopo por dono (F3) tira o contato do colega → null se não for de quem liga.
 */
async function assertContactInScope(
  prisma: ReturnType<typeof db>,
  contactId: string,
): Promise<void> {
  // Auditoria de isolamento 09/2026: também o escopo por dono. Só o time não
  // bastava — o vendedor registrava ligação no contato do colega (a atividade
  // entrava na linha do tempo dele e a resposta trazia o nome). O POST /api/calls
  // saiu na F1A-08; a regra fica, porque `createCall` segue sendo escrita com FK.
  const found = await prisma.contact.findFirst({
    where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] },
    select: { id: true },
  });
  if (!found) {
    throw new CallValidationError(
      `ContactNotFound no time atual (contactId=${contactId}).`,
    );
  }
}

/** Cria uma ligação + uma Activity tipo 'call' direcao out/in, de forma atômica. */
export async function createCall(data: CreateCallInput) {
  requireCan("calls.write");
  const prisma = db();
  const phoneNumber = normalizePhone(data.phoneNumber) ?? data.phoneNumber;
  // valida escopo do contato ANTES do transaction (captura já feita em prisma)
  await assertContactInScope(prisma, data.contactId);
  // S1: a conta é FK de coluna única: confere que é do time, venha de onde vier.
  await assertOwnedIfPresent("channelAccount", data.channelAccountId);

  const created = await prisma.$transaction(async (tx) => {
    const call = await tx.call.create({
      data: tenantData<Prisma.CallUncheckedCreateInput>({
        contactId: data.contactId,
        phoneNumber,
        direction: data.direction,
        userId: donoPadrao(), // F3: quem ligou
        provider: data.provider,
        ...(data.channelAccountId ? { channelAccountId: data.channelAccountId } : {}),
        ...(data.providerCallId ? { providerCallId: data.providerCallId } : {}),
      }),
      include: { contact: { select: { id: true, nome: true } } },
    });
    // Activity de rastreabilidade — mesma filosofia do moveDeal (§6.4).
    await tx.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId: data.contactId,
        tipo: "call",
        direcao: activityDirecao(data.direction),
        conteudo: `${data.direction === "outbound" ? "Ligação para" : "Ligação de"} ${phoneNumber}`,
        meta: { callId: call.id, provider: data.provider, direction: data.direction, phoneNumber },
      }),
    });
    return call;
  });
  return created;
}

/** Filtros de listagem de ligações (todos opcionais). */
export type CallListFilters = {
  status?: CallStatus;
  contactId?: string;
  /** createdAt >= from */
  from?: Date;
  /** createdAt <= to */
  to?: Date;
  /** id da última linha vista (paginação cursor-based; precede offset). */
  cursor?: string;
  limit?: number;
  offset?: number;
};

type CallWithContact = Prisma.CallGetPayload<{ include: { contact: { select: { id: true; nome: true } } } }>;

/**
 * Lista ligações do time com filtros opcionais (status, contato, período) e
 * paginação cursor-based (§paginação). `cursor` precede `offset`; sem ambos,
 * primeira página. `orderBy` termina em `id` (desempate estável do cursor).
 */
export async function listCalls(
  filters: CallListFilters = {},
): Promise<CursorPaginationResult<CallWithContact>> {
  const prisma = db();
  const { status, contactId, from, to, cursor, limit = 50, offset = 0 } = filters;
  const where: Prisma.CallWhereInput = {};
  if (status) where.status = status;
  if (contactId) where.contactId = contactId;
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }
  const rows = await prisma.call.findMany({
    where: { AND: [where, escopoLigacao()] }, // F3: as ligações de quem ligou
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { contact: { select: { id: true, nome: true } } },
    ...(cursor ? applyCursor({ cursor, limit }) : { take: limit + 1, skip: offset }),
  });
  return buildResult(rows, limit);
}

/** Busca uma ligação pelo id (escopo do time — findUnique fail-closed). */
export async function getCall(callId: string) {
  const prisma = db();
  const call = await prisma.call.findFirst({
    where: { AND: [{ id: callId }, escopoLigacao()] },
    include: { contact: { select: { id: true, nome: true } } },
  });
  if (!call) throw new CallNotFound(callId);
  return call;
}

/**
 * Anota a ligação pela API (`PATCH /api/calls/:id`): grava SÓ `notes` e `disposition`
 * (F1A-08, lista de permissão; o schema da borda é `anotarLigacaoApiSchema`). Status,
 * duração, gravação e transcrição são do provedor e não passam por aqui. Acha a Call
 * com o escopo de ESCRITA de Ligações (`escopoLigacao({ escrita: true })`): o vendedor
 * só anota a que ele fez, e "Ver de todos" sem "editar de todos" não altera a do colega.
 * Ligação de outro time ou fora do escopo é `CallNotFound` (mesma resposta), nada muda.
 * Idempotente: repetir o mesmo corpo deixa a mesma ligação. Texto em branco (já aparado pelo schema)
 * LIMPA o campo e grava `null`, como o resto do core faz com texto vazio: nunca fica `""` na coluna.
 */
export async function anotarCamposDaLigacao(callId: string, dados: AnotarLigacaoApiInput) {
  requireCan("calls.write");
  const prisma = db();
  const call = await prisma.call.findFirst({
    where: { AND: [{ id: callId }, escopoLigacao({ escrita: true })] },
    select: { id: true },
  });
  if (!call) throw new CallNotFound(callId);
  return prisma.call.update({
    where: { id: call.id },
    data: {
      ...(dados.notes !== undefined ? { notes: dados.notes || null } : {}),
      ...(dados.disposition !== undefined ? { disposition: dados.disposition || null } : {}),
    },
    include: { contact: { select: { id: true, nome: true } } },
  });
}

/**
 * Atualiza status/ciclo da ligação. `getCall` valida existência + escopo
 * (lança CallNotFound); depois o update só roda se a call pertence ao time
 * (where injeta teamId). INTERNO: hoje só o aplicador da Voopi chama (a API não;
 * a catraca confere), e sai com ele na F1A-11.
 */
export async function updateCallStatus(callId: string, data: UpdateCallStatusInput) {
  requireCan("calls.write");
  const prisma = db();
  await getCall(callId);
  return prisma.call.update({
    where: { id: callId },
    data: {
      status: data.status,
      ...(data.startedAt ? { startedAt: data.startedAt } : {}),
      ...(data.endedAt ? { endedAt: data.endedAt } : {}),
      ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}),
      ...(data.disposition !== undefined ? { disposition: data.disposition } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
    include: { contact: { select: { id: true, nome: true } } },
  });
}

/** Atualiza transcrição/resumo/áudio (preenchido pelo worker pós-chamada). */
export async function updateCallTranscription(callId: string, data: UpdateCallTranscriptionInput) {
  requireCan("calls.write");
  const prisma = db();
  await getCall(callId);
  return prisma.call.update({
    where: { id: callId },
    data: {
      ...(data.transcript !== undefined ? { transcript: data.transcript } : {}),
      ...(data.summary !== undefined ? { summary: data.summary } : {}),
      ...(data.recordingUrl !== undefined ? { recordingUrl: data.recordingUrl } : {}),
    },
    include: { contact: { select: { id: true, nome: true } } },
  });
}

/**
 * Ordem da máquina de estados de Call (scheduled → ringing → … → completed).
 * Usada só pra NÃO REGREDIR: um `call.ended` confirmado nunca pode voltar pra
 * `ringing`, mesmo se a Voopi mandar um `call.answered` atrasado (ordem de
 * chegada não é garantida — mesmo problema do recibo WhatsApp `applyStatusUpdate`).
 */
const CALL_STATUS_ORDER: Record<CallStatus, number> = {
  scheduled: 0,
  ringing: 1,
  answered: 2,
  no_answer: 3,
  busy: 3,
  failed: 3,
  completed: 4,
};

/** Onde o webhook pode mexer (ver `autenticarWebhookVoopi`). */
export type EscopoDoEventoVoopi = {
  /** `ref` do callbackUrl (id da nossa Call), com o segredo global na rota. */
  ref?: string | null;
  /**
   * Evento ASSINADO para uma ligação (`ref` + `sig`): só pode tocar ESTA Call —
   * e, se ela já tem id da Voopi, só com esse id. A assinatura de uma ligação
   * do time A não serve para mexer na do time B.
   */
  soDaLigacao?: string | null;
};

const ehUuid = (v: string | null | undefined): v is string => !!v && z.string().uuid().safeParse(v).success;

/**
 * A Call do evento.
 *  - Assinado (`soDaLigacao`): só a Call `ref`, da Voopi; com id da Voopi já
 *    gravado, ele tem de bater; sem id (aviso antes da resposta da API), o
 *    número do evento tem de ser o dela.
 *  - Segredo global: pelo id da Voopi; se o aviso chegou ANTES de gravarmos
 *    esse id, pelo `ref` — a NOSSA Call, da Voopi, ainda sem id e para o mesmo
 *    número.
 */
async function ligacaoDoEvento(ev: VoopiWebhookEvent, escopo: EscopoDoEventoVoopi) {
  const select = { id: true, teamId: true, contactId: true, status: true, phoneNumber: true, providerCallId: true } as const;
  const mesmoNumero = (c: { phoneNumber: string }) => phoneVariants(normalizePhone(ev.to)).includes(c.phoneNumber);
  if (escopo.soDaLigacao !== undefined && escopo.soDaLigacao !== null) {
    if (!ehUuid(escopo.soDaLigacao)) return null;
    const c = await basePrisma.call.findFirst({ where: { id: escopo.soDaLigacao, provider: "voopi" }, select });
    if (!c) return null;
    if (c.providerCallId) return c.providerCallId === ev.callId ? c : null;
    return mesmoNumero(c) ? c : null;
  }
  const pelaVoopi = await basePrisma.call.findFirst({ where: { providerCallId: ev.callId }, select });
  if (pelaVoopi || !ehUuid(escopo.ref)) return pelaVoopi;
  const candidata = await basePrisma.call.findFirst({ where: { id: escopo.ref, provider: "voopi", providerCallId: null }, select });
  return candidata && mesmoNumero(candidata) ? candidata : null;
}

/**
 * Aplica um evento de webhook da Voopi (call.answered/ended/recording) na Call
 * correspondente. Self-contained como o `applyStatusUpdate`/`receiveInbound`: o
 * webhook não tem contexto de tenancy prévio (vem server-to-server, sem sessão),
 * então resolvemos a Call CROSS-TEAM pelo `providerCallId` (índice
 * `@@index([providerCallId])` no Prisma) e abrimos `runWithTeam` com o time dela.
 *
 * O que faz por evento:
 *  - call.answered → status `answered` + `startedAt` (se ainda pré-atendimento)
 *    + publica `call:answered` no redis-bus.
 *  - call.ended    → status `completed` + `endedAt` + `durationSeconds` (sem
 *    regredir de um estado terminal) + publica `call:ended`. Se a Voopi disse
 *    como terminou (não atendida/ocupado/caixa postal/atendida), grava o
 *    resultado do produto §D — só se o vendedor ainda não marcou.
 *  - call.recording → grava `recordingUrl` (updateCallTranscription) + publica
 *    `call:recording`.
 * Em `answered`/`ended` também dispara `dashboard:changed` (ligações mexem nos
 * KPIs do "motor do dia"). A transcrição é agendada quando a ligação tem as
 * DUAS coisas — gravação e `completed` —, venha o que vier por último (ver
 * `agendarTranscricaoSePronta`).
 *
 * Ignora webhooks de chamadas que não são nossas (Call não encontrada) —
 * idêntico ao `applyStatusUpdate` ignorar recibos de mensagens externas.
 */
export async function applyVoopiWebhookEvent(ev: VoopiWebhookEvent, escopo: EscopoDoEventoVoopi = {}): Promise<void> {
  const call = await ligacaoDoEvento(ev, escopo);
  if (!call) return;

  await runAsSystem(call.teamId, async () => {
    const now = new Date();
    if (!call.providerCallId) {
      await db().call.updateMany({ where: { id: call.id, providerCallId: null }, data: { providerCallId: ev.callId } });
    }
    const current = call.status;
    // Só avança na máquina de estados — nunca regredir (ver CALL_STATUS_ORDER).
    const advances = (next: CallStatus): boolean => CALL_STATUS_ORDER[next] > CALL_STATUS_ORDER[current];

    if (ev.event === "call.answered") {
      // Só atualiza se ainda pré-atendimento (scheduled/ringing). Já atendida ou
      // terminal → ignora (idempotente contra reentrega atrasada da Voopi).
      if (!advances("answered")) return;
      await updateCallStatus(call.id, {
        status: "answered",
        startedAt: now,
        ...(ev.duration !== undefined ? { durationSeconds: ev.duration } : {}),
      });
      publishRealtime({
        type: "call:answered",
        callId: call.id,
        contactId: call.contactId,
        durationSeconds: ev.duration ?? null,
      });
      publishRealtime({ type: "dashboard:changed" });
      return;
    }

    if (ev.event === "call.ended") {
      // Como terminou, se a Voopi disse (produto §D). Sem isso: `completed`, o
      // topo da máquina (4) — setá-lo é sempre avanço ou no-op. Não atendida/
      // ocupado viram o status deles, a não ser que já esteja `completed`.
      // endedAt/duração valem mesmo chegando fora de ordem contra call.answered.
      const resultado = resultadoDoEventoVoopi(ev);
      const alvo: CallStatus =
        resultado === "no_answer" || resultado === "voicemail" ? "no_answer" : resultado === "busy" ? "busy" : "completed";
      await updateCallStatus(call.id, {
        status: current === "completed" ? "completed" : alvo,
        endedAt: now,
        ...(ev.duration !== undefined ? { durationSeconds: ev.duration } : {}),
      });
      if (resultado) await resultadoPelaVoopi(call, resultado, now);
      publishRealtime({
        type: "call:ended",
        callId: call.id,
        contactId: call.contactId,
        durationSeconds: ev.duration ?? null,
      });
      publishRealtime({ type: "dashboard:changed" });
      // A gravação pode ter chegado ANTES do fim da ligação.
      await agendarTranscricaoSePronta(call.id);
      return;
    }

    // call.recording — sem mudança de status; só grava a URL do áudio.
    // S13: só https em host da Voopi — o serviço de transcrição BAIXA essa URL.
    if (ev.recordingUrl) {
      if (!gravacaoPermitida(ev.recordingUrl)) {
        logger.warn({ callId: call.id }, "[voopi] recordingUrl fora dos hosts permitidos — ignorada");
        return;
      }
      await updateCallTranscription(call.id, { recordingUrl: ev.recordingUrl });
      publishRealtime({
        type: "call:recording",
        callId: call.id,
        recordingUrl: ev.recordingUrl,
      });
      // Transcrição + resumo em background (worker), se a ligação já terminou.
      await agendarTranscricaoSePronta(call.id);
    }
  });
}

/**
 * Resultado informado pela Voopi no fim da ligação → `Call.outcome` com os
 * efeitos do produto §D (caixa postal marca o retorno). NUNCA passa por cima
 * do que o vendedor já marcou (`soSeVazio`). Roda no contexto do time.
 */
async function resultadoPelaVoopi(
  call: { id: string; contactId: string; phoneNumber: string },
  resultado: CallOutcome,
  agora: Date,
): Promise<void> {
  const prisma = db();
  const cfg = resultado === "voicemail" ? await getTeamConfig() : null;
  const contato = await prisma.contact.findUnique({ where: { id: call.contactId }, select: { nome: true } });
  await prisma.$transaction(async (tx) => {
    // Trava a linha da Call (mesma ordem do pop-up e do discador).
    await tx.call.update({ where: { id: call.id }, data: { updatedAt: agora } });
    const r = await registrarResultado(tx, call, resultado, {
      agora,
      cfg,
      contatoNome: contato?.nome ?? call.phoneNumber,
      soSeVazio: true,
    });
    if (!r.mudou) return;
    const activity = await tx.activity.findFirst({
      where: { tipo: "call", meta: { path: ["callId"], equals: call.id } },
      orderBy: { createdAt: "desc" },
    });
    if (activity) {
      await tx.activity.update({
        where: { id: activity.id },
        data: {
          conteudo: textoDoResultado(resultado),
          meta: {
            ...((activity.meta as Record<string, unknown> | null) ?? {}),
            outcome: resultado,
            origemResultado: "voopi",
            ...(r.retorno ? { retornoAppointmentId: r.retorno.appointmentId } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }
  });
}

/**
 * Agenda a transcrição quando a ligação tem gravação E está `completed`.
 *
 * Antes era agendada só no `call.recording`: se a gravação chegava antes do
 * `call.ended`, o job rodava com a ligação ainda em curso, saía sem fazer nada
 * e o jobId (um por ligação) impedia agendar de novo — a ligação nunca era
 * transcrita. Agora os dois eventos chamam isto DEPOIS de gravar e releem a
 * ligação — a leitura vem depois da escrita DE PROPÓSITO: qualquer que seja a
 * ordem (ou se chegarem juntos), a última leitura vê as duas coisas. Dois agendamentos → o jobId deduplica. Falha de fila não
 * perde a gravação (fica o aviso no log). Roda no contexto do time.
 */
async function agendarTranscricaoSePronta(callId: string): Promise<void> {
  const atual = await db().call.findUnique({ where: { id: callId }, select: { status: true, recordingUrl: true } });
  if (!atual?.recordingUrl || atual.status !== "completed") return;
  // Sem serviço de transcrição não agenda: o job só falharia ("transcrição não
  // configurada") em toda ligação gravada. A gravação fica na ligação.
  if (!process.env.TRANSCRIPTION_SERVICE_URL) {
    logger.info({ callId }, "[voopi] gravação sem transcrição — TRANSCRIPTION_SERVICE_URL não configurada");
    return;
  }
  await scheduleTranscription(callId).catch((e: unknown) =>
    logger.warn({ callId, err: e instanceof Error ? e.message : String(e) }, "[voopi] falha ao agendar transcrição"),
  );
}

// ─── Discador pop-up + telas de gestão (Fase 5) ────────────────────────────

/**
 * Lista Activities de ligação (tipo=call) para a aba "Ligações" — o histórico
 * do dia (ou período). Paginação cursor-based pelo id (desc). Traz contato +
 * telefone/email principais para exibir no card. Inclui ligações do discador
 * progressivo, do pop-up manual e as criadas pelo nó `manual_call` do fluxo
 * (nesse caso, sem Call correspondente — só Activity).
 */
export async function listCallActivities(
  filters: { from?: Date; to?: Date; cursor?: string; limit?: number; offset?: number } = {},
) {
  const prisma = db();
  const { from, to, cursor, limit = 100, offset = 0 } = filters;
  // F3: ligações dos contatos que a pessoa vê.
  const where: Prisma.ActivityWhereInput = { tipo: "call", contact: escopoDoContato() };
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }
  const rows = await prisma.activity.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      contact: {
        select: { id: true, nome: true, empresa: true, identifiers: true },
      },
    },
    ...(cursor ? applyCursor({ cursor, limit }) : { take: limit + 1, skip: offset }),
  });
  const page = buildResult(rows, limit);
  return {
    ...page,
    items: page.items.map((a) => ({
      id: a.id,
      contactId: a.contactId,
      contactNome: a.contact.nome,
      contactEmpresa: a.contact.empresa,
      telefone: primaryTelefone(a.contact.identifiers),
      email: primaryEmail(a.contact.identifiers),
      direcao: a.direcao,
      conteudo: a.conteudo,
      meta: a.meta as Record<string, unknown> | null,
      dealId: a.dealId,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * Pendências da aba "Atividades": ligações que ainda não foram finalizadas.
 * Junta duas fontes:
 *  - Calls com status scheduled/ringing (discador progressivo ou pop-up que
 *    ainda não recebeu resultado);
 *  - Activities call com meta.status=pending (nó `manual_call` do fluxo, que
 *    segura o passo até o vendedor marcar feita — não tem Call, só Activity).
 */
export async function listPendingCalls() {
  const prisma = db();
  const [scheduledCalls, pendingActivities] = await Promise.all([
    prisma.call.findMany({
      where: { AND: [{ status: { in: ["scheduled", "ringing"] } }, escopoLigacao()] },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        contact: {
          select: { id: true, nome: true, empresa: true, identifiers: true },
        },
      },
    }),
    prisma.activity.findMany({
      // Tarefa de ligação do fluxo: aparece para quem vê o contato (F3).
      where: { tipo: "call", meta: { path: ["status"], equals: "pending" }, contact: escopoDoContato() },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        contact: {
          select: { id: true, nome: true, empresa: true, identifiers: true },
        },
      },
    }),
  ]);

  const fromCalls = scheduledCalls.map((c) => ({
    kind: "scheduled" as const,
    id: c.id,
    callId: c.id,
    contactId: c.contactId,
    contactNome: c.contact.nome,
    contactEmpresa: c.contact.empresa,
    telefone: c.contact.identifiers.length
      ? primaryTelefone(c.contact.identifiers)
      : c.phoneNumber,
    status: c.status,
    disposition: c.disposition,
    notes: c.notes,
    provider: c.provider,
    createdAt: c.createdAt.toISOString(),
  }));
  const fromActivities = pendingActivities.map((a) => ({
    kind: "pending_activity" as const,
    id: a.id,
    callId: null,
    contactId: a.contactId,
    contactNome: a.contact.nome,
    contactEmpresa: a.contact.empresa,
    telefone: primaryTelefone(a.contact.identifiers),
    status: "pending" as const,
    disposition: null,
    notes: (a.meta as { roteiro?: string } | null)?.roteiro ?? null,
    provider: null,
    createdAt: a.createdAt.toISOString(),
  }));
  return [...fromCalls, ...fromActivities].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

/** Contato resumido para a aba Contatos (só os que têm telefone). */
export type CallContactListItem = {
  id: string;
  nome: string;
  empresa: string | null;
  cargo: string | null;
  telefone: string | null;
  tags: string[];
};

/**
 * Lista contatos com telefone (aba Contatos da tela de Ligações). Paginação
 * offset + busca por nome/empresa/telefone. Ordenado por nome.
 */
export async function listContactsForCalls(
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ items: CallContactListItem[]; total: number }> {
  const prisma = db();
  const { search, limit = 50, offset = 0 } = opts;
  // Telefone: por trecho ou, com a cifra em `indice`/`ligada`, por número completo (índice cego).
  const porIdentificador = search ? ondeBuscaDeIdentificador(getCurrentTeamId() ?? "", search, { insensivel: false }) : null;
  const where: Prisma.ContactWhereInput = {
    AND: [escopoDoContato()], // F3: os contatos de quem liga
    identifiers: { some: { canal: "whatsapp" } },
    ...(search
      ? {
          OR: [
            { nome: { contains: search, mode: "insensitive" } },
            { empresa: { contains: search, mode: "insensitive" } },
            ...(porIdentificador ? [{ identifiers: { some: porIdentificador } }] : []),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: [{ nome: "asc" }, { id: "asc" }],
      take: limit,
      skip: offset,
      select: {
        id: true,
        nome: true,
        empresa: true,
        cargo: true,
        tags: true,
        // O número que o discador usaria: válido primeiro, depois o primário.
        identifiers: {
          where: { canal: "whatsapp" },
          orderBy: [{ invalido: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
          select: { valor: true },
          take: 1,
        },
      },
    }),
    prisma.contact.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      empresa: r.empresa,
      cargo: r.cargo,
      telefone: r.identifiers[0]?.valor ?? null,
      tags: r.tags,
    })),
    total,
  };
}

/**
 * Cria uma ligação manual (discador pop-up): número digitado + contato opcional.
 * Nasce `scheduled` + Activity call out. Se o número bate com um contato
 * existente (e `contactId` não veio), vincula automaticamente. Retorna a Call
 * criada com o contactId resolvido — o front usa o id para finalizar depois.
 */
export async function createManualCall(input: {
  phoneNumber: string;
  contactId?: string;
}): Promise<{ callId: string; contactId: string | null; contactNome: string | null }> {
  requireCan("calls.write");
  const prisma = db();
  const phoneNumber = normalizePhone(input.phoneNumber) ?? input.phoneNumber;

  let contactId = input.contactId;
  let contactNome: string | null = null;

  if (!contactId) {
    // Tenta resolver pelo número normalizado — evita duplicar contato ao discar.
    const found = await prisma.contact.findFirst({
      where: { identifiers: { some: { canal: "whatsapp", valor: phoneNumber } } },
      select: { id: true, nome: true },
    });
    if (found) {
      // O número é de um contato de OUTRO responsável (regra do dono, 28/09):
      // não liga "no nome dele" nem cria outro contato com o mesmo número.
      await recusarSeDeOutro(found.id, await quemAge());
      contactId = found.id;
      contactNome = found.nome;
    }
  } else {
    // F3: e do escopo de quem liga (o contato de outro vendedor não é aceito).
    const c = await prisma.contact.findFirst({
      where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] },
      select: { nome: true },
    });
    // S1: antes seguia com o contactId alheio (só o nome vinha null) e gravava
    // a Call/Activity do meu time apontando para o contato de outro time.
    if (!c) throw new OwnedNotFound("contact", [contactId]);
    contactNome = c.nome;
  }

  // Sem contato (número avulso): cria a Call sem contactId é impossível (FK
  // obrigatória). Nesse caso, criamos um contato mínimo para ancorar a ligação
  // — o vendedor pode enriquecer depois. Nome vira o próprio número formatado.
  if (!contactId) {
    const created = await prisma.contact.create({
      data: tenantData<Prisma.ContactUncheckedCreateInput>({
        nome: phoneNumber,
        origem: "ligacao_manual",
        ownerId: await responsavelObrigatorio(donoPadrao()), // de quem ligou (obrigatório)
      }),
      select: { id: true, nome: true },
    });
    await prisma.channelIdentifier.create({
      data: tenantData<Prisma.ChannelIdentifierUncheckedCreateInput>({
        contactId: created.id,
        canal: "whatsapp",
        valor: phoneNumber,
        isPrimary: true,
      }),
    });
    contactId = created.id;
    contactNome = created.nome;
  }

  const call = await prisma.$transaction(async (tx) => {
    const c = await tx.call.create({
      data: tenantData<Prisma.CallUncheckedCreateInput>({
        contactId,
        phoneNumber,
        direction: "outbound",
        userId: donoPadrao(), // F3: quem ligou
        status: "scheduled",
        provider: "manual",
      }),
    });
    await tx.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId,
        tipo: "call",
        direcao: "out",
        conteudo: `Ligação para ${phoneNumber}`,
        meta: { callId: c.id, provider: "manual", direction: "outbound", phoneNumber },
      }),
    });
    return c;
  });

  return { callId: call.id, contactId, contactNome };
}

/** Resposta de `finishManualCall` (a tela mostra o retorno marcado / o número invalidado). */
export type FinalizacaoDaLigacao = {
  outcome: CallOutcome;
  /** Caixa postal: retorno marcado na Agenda (só na 1ª vez que o resultado vira caixa postal). */
  retorno: EfeitosDoResultado["retorno"];
  /** Número errado: quantos números do contato ficaram inválidos. */
  numerosInvalidados: number;
};

/**
 * Finaliza uma ligação manual (pop-up): registra outcome, duração, anotações e
 * opcionalmente vincula a um negócio/etapa. Atualiza a Call (status/datas) e a
 * Activity correspondente (conteudo/dealId). Se `dealId` informado e `stageId`
 * também, move o negócio para a etapa (reuso de `moveDeal` — dispara stage_changed).
 *
 * `outcome` (produto §D): answered/no_answer/busy/voicemail/wrong_number/skip.
 * Caixa postal marca o retorno em 2 dias úteis; número errado invalida o número
 * do contato (ver `resultado.ts`). Os efeitos só rodam quando o resultado muda.
 */
export async function finishManualCall(
  callId: string,
  input: FinishManualCallInput,
  opts: { agora?: Date } = {},
): Promise<FinalizacaoDaLigacao> {
  requireCan("calls.write");
  const prisma = db();
  const dados = finishManualCallSchema.parse(input);
  const call = await prisma.call.findFirst({
    where: { AND: [{ id: callId }, escopoLigacao({ escrita: true })] },
    include: { contact: { select: { nome: true } } },
  });
  if (!call) throw new CallNotFound(callId);
  // S1: o negócio escolhido no pop-up vira FK da Activity — tem de ser do time.
  await assertOwnedIfPresent("deal", dados.dealId);

  const now = opts.agora ?? new Date();
  const outcome = dados.outcome;
  const newStatus: CallStatus =
    outcome === "answered"
      ? "completed"
      : outcome === "no_answer"
        ? "no_answer"
        : outcome === "busy"
          ? "busy"
          : outcome === "voicemail" || outcome === "wrong_number"
            ? STATUS_DOS_RESULTADOS_NOVOS[outcome]
            : "completed";
  // Calendário do time (dias úteis/feriados) — lido fora da transação.
  const cfg = outcome === "voicemail" ? await getTeamConfig() : null;

  const resumo = dados.notes?.trim() ?? "";
  const disposition = dados.disposition?.trim() || null;

  // Ligação da Voopi: status, horários e duração são do webhook (reais). O
  // vendedor só marca o resultado — e fecha o status se o webhook não veio.
  const daVoopi = call.provider === "voopi";

  const efeitos = await prisma.$transaction(async (tx) => {
    await tx.call.update({
      where: { id: callId },
      data: {
        ...(daVoopi
          ? {}
          : {
              status: newStatus,
              ...(outcome === "answered"
                ? { startedAt: now, endedAt: now, durationSeconds: dados.durationSec ?? 0 }
                : {}),
            }),
        ...(resumo ? { notes: resumo } : {}),
        ...(disposition ? { disposition } : {}),
      },
    });
    if (daVoopi) {
      await tx.call.updateMany({ where: { id: callId, status: { in: ["scheduled", "ringing"] } }, data: { status: newStatus } });
    }
    const ef: EfeitosDoResultado = await registrarResultado(tx, call, outcome, {
      agora: now,
      cfg,
      contatoNome: call.contact.nome,
    });

    // Atualiza a Activity de rastreabilidade (conteudo + dealId).
    const activity = await tx.activity.findFirst({
      where: { tipo: "call", meta: { path: ["callId"], equals: callId } },
      orderBy: { createdAt: "desc" },
    });
    if (activity) {
      const conteudo = [
        resumo ? `${textoDoResultado(outcome)}: ${resumo}` : textoDoResultado(outcome),
        disposition ? `(${disposition})` : null,
      ]
        .filter(Boolean)
        .join(" ");
      await tx.activity.update({
        where: { id: activity.id },
        data: {
          conteudo,
          ...(dados.dealId ? { dealId: dados.dealId } : {}),
          meta: {
            ...((activity.meta as Record<string, unknown> | null) ?? {}),
            outcome,
            durationSec: dados.durationSec ?? 0,
            disposition,
            dealId: dados.dealId ?? null,
            ...(ef.retorno ? { retornoAppointmentId: ef.retorno.appointmentId } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }
    return ef;
  });

  // Move de etapa (fora da tx — moveDeal cria sua própria Activity de stage_change
  // e dispara trigger do motor). Só se veio dealId+stageId e é diferente.
  if (dados.dealId && dados.stageId) {
    const { moveDeal } = await import("../funnels/service");
    try {
      await moveDeal(dados.dealId, dados.stageId);
    } catch {
      // não fatal — a ligação já foi finalizada; etapa é best-effort.
    }
  }

  publishRealtime({ type: "dashboard:changed" });
  return { outcome, retorno: efeitos.retorno, numerosInvalidados: efeitos.numerosInvalidados };
}

/**
 * Lista negócios abertos de um contato + todos os funis/etapas do time — usado
 * pelo pop-up para o seletor "vincular a negócio/etapa". Evita importar lógica
 * de funil no front.
 */
export async function listDealOptionsForContact(contactId: string) {
  const prisma = db();
  // F3: só o contato do escopo, e só os negócios de quem pede. Só LÊ (o pop-up).
  await assertOwned("contact", contactId, { leitura: true });
  const [deals, funnels] = await Promise.all([
    prisma.deal.findMany({
      where: { AND: [{ contactId, status: "open" }, escopoNegocio()] },
      orderBy: { enteredStageAt: "desc" },
      include: { stage: { include: { funnel: { select: { id: true, nome: true } } } } },
    }),
    prisma.funnel.findMany({
      orderBy: { createdAt: "asc" },
      include: { stages: { orderBy: { ordem: "asc" } } },
    }),
  ]);
  return {
    deals: deals.map((d) => ({
      id: d.id,
      stageId: d.stageId,
      funnelId: d.stage.funnel.id,
      funilNome: d.stage.funnel.nome,
      etapaNome: d.stage.nome,
      valor: Number(d.valor),
    })),
    funnels: funnels.map((f) => ({
      id: f.id,
      nome: f.nome,
      stages: (f.stages as Array<{ id: string; nome: string; ordem: number }>).map((s) => ({
        id: s.id,
        nome: s.nome,
      })),
    })),
  };
}
