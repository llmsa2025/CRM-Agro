import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type AppointmentStatus } from "@prisma/client";
import { env } from "@crmagro/config";
import { basePrisma, db, getCurrentTeamId, runAsSystem, runWithTeam } from "@crmagro/db";
import { ondeIdentificadorExato, valorDe } from "../../contacts/identificadores-cifra";
import { requireCan } from "../../auth/authz";
import { verTudoEmDoLegado } from "../../auth/modulos";
import { logger } from "../../logger/index";
import { zonedTimeToUtc } from "../../motor-do-dia/tz";
import { redisEstado } from "../../shared/redis-cache";
import {
  atualizarRespostas,
  colegasPorEmail,
  contatosPorEmail,
  MAX_CONVIDADOS_TOTAL,
  normalizarEmail,
  substituirConvidados,
  type ConvidadoNormalizado,
} from "../convidados";
import { assistirAgenda, GoogleApiErro, GoogleAutorizacaoInvalida, listarEventos, obterEvento, pararCanal, type EventoGoogle } from "./cliente";
import { agendaGoogleLiberadaPara, marcarReautorizacao, pushDaAgendaHabilitado, urlPublicaDoApp } from "./conexao";
import {
  avisarConvidadosPeloIcs,
  comAcesso,
  compromissoDoIdGoogle,
  conexaoEmUso,
  erroSeguro,
  fusoDoTime,
  hashDosCamposComuns,
  LIMITE_DESCRICAO_IMPORTADA,
  LIMITE_LOCAL_IMPORTADO,
  LIMITE_TITULO_IMPORTADO,
  linkDaReuniao,
  provedorDaReuniao,
  retratoParaOGoogle,
} from "./envio";
import { enfileirarSyncGoogle } from "./fila";

export { pushDaAgendaHabilitado } from "./conexao";

/**
 * Google → CRM Agro (fase 1): sincronização INCREMENTAL por `syncToken`, no worker.
 *
 * Privacidade (decisão 4):
 * - A lista pede só `id`, título, horário, status e convidados (`fields=`):
 *   descrição e local de evento pessoal nem saem do Google. O título do evento
 *   pessoal fica no bloco e só a DONA da agenda o vê. Os e-mails dos
 *   convidados servem só para achar contato, em memória — nunca gravados nem
 *   logados para evento pessoal.
 * - Vira compromisso completo (aí sim busca o evento inteiro) só o evento
 *   com um contato DA PRÓPRIA PESSOA (dono do contato; não o compartilhado nem
 *   o que ela vê por "ver tudo") e que ela mesma organizou, ou que aceitou
 *   quando o organizador é o próprio contato ou um colega. Convite de um
 *   terceiro qualquer não puxa nada para o CRM. O resto vira bloco "Ocupado":
 *   início, fim, id no Google e o título (visível só para a dona).
 *
 * Conflito (decisão 5): vence a alteração mais recente dos campos comuns
 * (`updated` do Google × `Appointment.camposComunsEm`). Só conta como
 * alteração do Google o que muda a impressão digital dos campos comuns
 * (`camposHash`): resposta de convidado e a criação do Meet NÃO atropelam uma
 * mudança do CRM Agro que ainda não chegou lá. Contato, negócio, tipo, lembrete e
 * responsável são só do CRM Agro: o Google nunca os apaga. As escritas conferem
 * o carimbo lido (CAS): um salvar no meio do caminho não é sobrescrito.
 *
 * Cancelamento (decisão 6): apagado/cancelado no Google → `cancelado` no
 * CRM Agro; o compromisso fica no histórico do contato. O que já aconteceu
 * (concluído, ou com o horário no passado) não muda: apagar lá é limpeza.
 *
 * Convidados: a lista do evento do Google só vale quando o convite saiu POR
 * ELE (canal = esta conexão). Evento que foi sem convidados (o convite saiu
 * pelo .ics do time ou por outra agenda) não apaga os do CRM Agro; se o Google
 * muda o horário, o título ou o local, os convidados recebem o .ics.
 *
 * O que vem do Google e vira compromisso fica só com a dona até ela confirmar
 * ("Manter no CRM Agro"): o gatilho depende do dono do contato, que outras
 * pessoas decidem.
 *
 * 410 Gone (cursor vencido) e janela vencendo (a completa pega só 180 dias à
 * frente e o `syncToken` não traz o que entra na janela com o tempo) →
 * sincronização completa (os "Ocupado" são refeitos; compromissos nunca são
 * apagados). 429/403 de cota e 5xx → espera crescente com sorteio. Trava por
 * conexão no Redis: nunca duas juntas.
 */

/** Só o que a sincronização precisa de cada evento (título só para a dona ver; nada de descrição nem local). */
export const CAMPOS_DA_LISTA =
  "nextPageToken,nextSyncToken,timeZone,items(id,iCalUID,status,etag,updated,summary,start,end,transparency,eventType,recurringEventId,extendedProperties/private,organizer(email,self),attendees(email,self,responseStatus,organizer,resource))";

const DIA = 24 * 60 * 60_000;
/** Janela da sincronização completa: 30 dias para trás, 180 para a frente. */
const JANELA_PASSADO_MS = 30 * DIA;
const JANELA_FUTURO_MS = 180 * DIA;
/** Refaz a completa quando faltam menos de 30 dias para o fim da janela. */
const JANELA_RENOVA_MS = 150 * DIA;
/** Polling de reserva (o aviso por push pode se perder): ~15 min, com sorteio de ±25%. */
const POLL_MS = Number(process.env.AGENDA_GOOGLE_POLL_MS ?? 15 * 60_000);
const MAX_PAGINAS = 40;
const TRAVA_S = 300;
/** Um evento que falha tantas rodadas seguidas é pulado (o cursor anda). */
const MAX_FALHAS_EVENTO = 5;
/** Espera antes de tentar abrir o canal de push de novo depois de uma falha. */
const ESPERA_CANAL_MS = 60 * 60_000;
/** Não ocupam o horário: aniversário e "local de trabalho". */
const TIPOS_IGNORADOS = new Set(["birthday", "workingLocation"]);

const SOLTAR_SE_MINHA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const chaveTrava = (connectionId: string) => `agenda:google:sync:${connectionId}`;
/** Aviso que chegou durante uma sincronização (o job da mesma janela de 10 s é ignorado pela fila). */
const chaveSujo = (connectionId: string) => `agenda:google:sujo:${connectionId}`;
const chaveFalhaDoEvento = (connectionId: string, eventId: string) => `agenda:google:evfalha:${connectionId}:${eventId.slice(0, 200)}`;

const sorteio = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

export type ResultadoSync =
  | { ok: true; completa: boolean; ocupados: number; compromissos: number; atualizados: number; cancelados: number; ignorados: number }
  | { ok: false; pulou: "sem_conexao" | "inativa" | "pessoa_desativada" | "parada" | "nao_liberada" | "travada" | "sem_redis" | "reautorizar" | "erro" };

type Identidade = { userId: string; role: string; modulos: string[]; verTudoEm: string[]; editarTudoEm: string[] };
type Ctx = {
  conn: {
    id: string;
    teamId: string;
    userId: string;
    status: string;
    credentials: unknown;
    accessTokenExpiraEm: Date | null;
  };
  /** O dono da agenda: o escopo dos contatos é o DELE (não o do sistema). */
  identidade: Identidade;
  /** Fuso da AGENDA no Google: só para os blocos "Ocupado" de dia inteiro. */
  fuso: string;
  /** Fuso do TIME: compromisso de dia inteiro, na ida e na volta (a data não anda). */
  fusoDoTime: string;
  agora: Date;
  estat: { ocupados: number; compromissos: number; atualizados: number; cancelados: number; ignorados: number };
};

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export async function sincronizarConexaoGoogle(connectionId: string, opts: { agora?: Date } = {}): Promise<ResultadoSync> {
  const agora = opts.agora ?? new Date();
  const conn = await basePrisma.oAuthConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      teamId: true,
      userId: true,
      status: true,
      credentials: true,
      accessTokenExpiraEm: true,
      user: { select: { email: true, role: true, modulos: true, verTudoEm: true, editarTudoEm: true, desativadoEm: true } },
    },
  });
  if (!conn) return { ok: false, pulou: "sem_conexao" };
  if (conn.status !== "connected") return { ok: false, pulou: "inativa" };
  if (conn.user.desativadoEm) return { ok: false, pulou: "pessoa_desativada" };
  // Virou "só leitura" ou perdeu a Agenda e as Integrações: a agenda fica parada.
  if (!conexaoEmUso(conn.user)) return { ok: false, pulou: "parada" };
  // A2: quem saiu de `GOOGLE_AGENDA_LIBERADOS` fica com a sincronização PARADA
  // (o worker só pula; nada é apagado, e a pessoa ainda desconecta). Volta
  // sozinha quando a lista voltar a incluí-la.
  if (!agendaGoogleLiberadaPara({ teamId: conn.teamId, email: conn.user.email })) return { ok: false, pulou: "nao_liberada" };

  const token = randomUUID();
  let travou = false;
  try {
    travou = (await redisEstado().set(chaveTrava(conn.id), token, "EX", TRAVA_S, "NX")) === "OK";
  } catch {
    // Sem Redis não há como garantir que outra rodada não está nesta agenda: pula.
    return { ok: false, pulou: "sem_redis" };
  }
  if (!travou) return { ok: false, pulou: "travada" };
  // A partir daqui, um aviso novo marca "sujo" e ganha outra rodada no fim.
  await redisEstado()
    .del(chaveSujo(conn.id))
    .catch(() => {});

  const { user, ...dados } = conn;
  const fusoTime = await fusoDoTime(conn.teamId);
  const ctx: Ctx = {
    conn: dados,
    identidade: {
      userId: conn.userId,
      role: user.role,
      modulos: user.modulos,
      verTudoEm: verTudoEmDoLegado(user.verTudoEm),
      editarTudoEm: user.editarTudoEm,
    },
    fuso: fusoTime,
    fusoDoTime: fusoTime,
    agora,
    estat: { ocupados: 0, compromissos: 0, atualizados: 0, cancelados: 0, ignorados: 0 },
  };
  try {
    return await sincronizarComTrava(ctx);
  } finally {
    // O Google avisou enquanto esta rodada corria: o job daquele aviso caiu na
    // mesma janela de 10 s (ignorado pela fila) — pede outra rodada.
    const sujo = await redisEstado()
      .exists(chaveSujo(conn.id))
      .catch(() => 0);
    if (sujo) await enfileirarSyncGoogle(conn.id, { atrasoMs: 10_000 }).catch(() => {});
    await redisEstado()
      .eval(SOLTAR_SE_MINHA, 1, chaveTrava(conn.id), token)
      .catch(() => {}); // expira sozinha
  }
}

/** Apaga os "Ocupado" da conexão (menos os que a pessoa tirou do CRM: eles guardam o "não importar"). */
async function apagarOcupadosDaConexao(ctx: Ctx): Promise<void> {
  await runAsSystem(ctx.conn.teamId, () => db().calendarBusyBlock.deleteMany({ where: { connectionId: ctx.conn.id, naoImportar: false } }));
}

async function sincronizarComTrava(ctx: Ctx): Promise<ResultadoSync> {
  const { conn, agora } = ctx;
  const sync = await runAsSystem(conn.teamId, () =>
    db().calendarSync.upsert({
      where: { connectionId_calendarId: { connectionId: conn.id, calendarId: "primary" } },
      create: { connectionId: conn.id, calendarId: "primary" } as Prisma.CalendarSyncUncheckedCreateInput,
      update: {},
      select: {
        id: true,
        syncToken: true,
        fusoHorario: true,
        canalId: true,
        canalResourceId: true,
        canalExpiraEm: true,
        canalTentarEm: true,
        janelaAte: true,
        falhas: true,
      },
    }),
  );
  if (sync.fusoHorario) ctx.fuso = sync.fusoHorario;
  let completa = !sync.syncToken;
  try {
    let r: { syncToken: string | null; fuso: string | null; terminou: boolean; falhou: number };
    // A janela da completa venceu (ou nunca foi marcada): o `syncToken` só traz
    // o que MUDOU, então as instâncias de séries que entram na janela com o
    // tempo nunca chegariam. Recomeça do zero.
    const janelaVencendo = Boolean(sync.syncToken) && (!sync.janelaAte || sync.janelaAte.getTime() < agora.getTime() + JANELA_RENOVA_MS);
    if (janelaVencendo) {
      await apagarOcupadosDaConexao(ctx);
      completa = true;
      r = await percorrer(ctx, null);
    } else {
      try {
        r = await percorrer(ctx, sync.syncToken);
      } catch (e) {
        if (!(e instanceof GoogleApiErro && e.status === 410)) throw e;
        // Cursor inválido: recomeça do zero. Os "Ocupado" são refeitos; os
        // compromissos (histórico) nunca saem.
        logger.info({ connectionId: conn.id }, "[agenda-google] cursor vencido (410) — sincronização completa");
        await apagarOcupadosDaConexao(ctx);
        completa = true;
        r = await percorrer(ctx, null);
      }
    }
    const inteira = r.terminou && r.falhou === 0;
    // Evento que falhou ao gravar: o cursor não anda (a próxima rodada refaz;
    // é idempotente) e a espera cresce — o erro aparece na tela.
    const falhas = inteira ? 0 : sync.falhas + 1;
    await runAsSystem(conn.teamId, () =>
      db().calendarSync.update({
        where: { id: sync.id },
        data: {
          ...(inteira ? { syncToken: r.syncToken } : {}),
          ...(inteira && completa ? { janelaAte: new Date(agora.getTime() + JANELA_FUTURO_MS) } : {}),
          ...(r.fuso ? { fusoHorario: r.fuso } : {}),
          ultimaSincronizacaoEm: agora,
          proximaSincronizacaoEm: new Date(
            agora.getTime() + (inteira ? sorteio(POLL_MS) : r.falhou ? sorteio(Math.min(60 * 60_000, 60_000 * 2 ** Math.min(falhas, 6))) : 60_000),
          ),
          falhas,
          ultimoErro: r.falhou ? `${r.falhou} evento(s) não aplicado(s). Tenta de novo` : null,
        },
      }),
    );
    await garantirCanal(ctx, sync);
    return { ok: true, completa, ...ctx.estat };
  } catch (e) {
    if (e instanceof GoogleAutorizacaoInvalida) return { ok: false, pulou: "reautorizar" };
    if (e instanceof GoogleApiErro && e.status === 403 && (e.motivo === "insufficientPermissions" || e.motivo === "forbidden")) {
      // A pessoa tirou a permissão da agenda na conta Google.
      await marcarReautorizacao(conn, "o Google tirou a permissão da agenda");
      return { ok: false, pulou: "reautorizar" };
    }
    const falhas = sync.falhas + 1;
    // Cota (403/429) e instabilidade (5xx): espera crescente com sorteio, até 1 h.
    const espera = sorteio(Math.min(60 * 60_000, 60_000 * 2 ** Math.min(falhas, 6)));
    const motivo = e instanceof GoogleApiErro ? e.message : "falha ao sincronizar";
    await runAsSystem(conn.teamId, () =>
      db().calendarSync.update({
        where: { id: sync.id },
        data: { falhas, ultimoErro: motivo.slice(0, 200), proximaSincronizacaoEm: new Date(agora.getTime() + espera) },
      }),
    ).catch(() => {});
    logger.warn({ connectionId: conn.id, falhas, err: motivo }, "[agenda-google] sincronização falhou (tenta de novo mais tarde)");
    return { ok: false, pulou: "erro" };
  }
}

const MOTIVOS_DE_COTA = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);
/**
 * Erro que é da AGENDA inteira (autorização, cota, Google fora): a rodada toda
 * espera (ou para), não o evento. Um 403/404 de UM evento conta só para ele.
 */
const erroDaRodada = (e: unknown) =>
  e instanceof GoogleAutorizacaoInvalida ||
  (e instanceof GoogleApiErro && (e.status === 429 || e.status >= 500 || (e.status === 403 && MOTIVOS_DE_COTA.has(e.motivo ?? ""))));

/** Mais uma falha deste evento (Redis, 1 dia); null sem Redis. */
async function contarFalhaDoEvento(connectionId: string, eventId: string): Promise<number | null> {
  try {
    const k = chaveFalhaDoEvento(connectionId, eventId);
    const n = await redisEstado().incr(k);
    await redisEstado().expire(k, 24 * 60 * 60);
    return n;
  } catch {
    return null;
  }
}

/** Percorre as páginas (incremental com `syncToken`, ou completa na janela). */
async function percorrer(ctx: Ctx, syncToken: string | null): Promise<{ syncToken: string | null; fuso: string | null; terminou: boolean; falhou: number }> {
  const { conn, agora } = ctx;
  let pageToken: string | undefined;
  let proximo: string | null = null;
  let fuso: string | null = null;
  let falhou = 0;
  let paginas = 0;
  do {
    const pagina = await comAcesso(conn, (t) =>
      listarEventos(t, "primary", {
        syncToken: syncToken ?? undefined,
        pageToken,
        timeMin: syncToken ? undefined : new Date(agora.getTime() - JANELA_PASSADO_MS).toISOString(),
        timeMax: syncToken ? undefined : new Date(agora.getTime() + JANELA_FUTURO_MS).toISOString(),
        fields: CAMPOS_DA_LISTA,
      }),
    );
    if (pagina.timeZone) {
      fuso = pagina.timeZone;
      ctx.fuso = pagina.timeZone;
    }
    for (const ev of pagina.items ?? []) {
      try {
        await aplicarEvento(ctx, ev);
      } catch (e) {
        if (erroDaRodada(e)) throw e;
        // Um evento com erro que se repete (404, dado que o banco recusa) não
        // pode travar o cursor para sempre: depois de algumas rodadas, é pulado.
        const vezes = ev?.id ? await contarFalhaDoEvento(conn.id, ev.id) : null;
        const err = erroSeguro(e);
        if (vezes !== null && vezes >= MAX_FALHAS_EVENTO) {
          logger.warn({ connectionId: conn.id, eventId: ev.id, vezes, err }, "[agenda-google] evento pulado depois de várias falhas");
          continue;
        }
        falhou++;
        // Só o id do evento no log (nada do conteúdo).
        logger.warn({ connectionId: conn.id, eventId: ev?.id, err }, "[agenda-google] evento não aplicado");
      }
    }
    pageToken = pagina.nextPageToken;
    proximo = pagina.nextSyncToken ?? proximo;
  } while (pageToken && ++paginas < MAX_PAGINAS);
  return { syncToken: proximo, fuso, terminou: !pageToken, falhou };
}

// ---------------------------------------------------------------------------
// Um evento
// ---------------------------------------------------------------------------

/** Instante de um horário do Google (dia inteiro = meia-noite no fuso dado). */
function instante(h: { dateTime?: string; date?: string } | undefined, fuso: string): Date | null {
  if (h?.dateTime) {
    const d = new Date(h.dateTime);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = h?.date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, fuso) : null;
}

function intervaloDoEvento(ev: EventoGoogle, fuso: string): { inicio: Date; fim: Date; diaInteiro: boolean } | null {
  const inicio = instante(ev.start, fuso);
  if (!inicio) return null;
  const diaInteiro = Boolean(ev.start?.date && !ev.start?.dateTime);
  const fim = instante(ev.end, fuso) ?? new Date(inicio.getTime() + (diaInteiro ? DIA : 60 * 60_000));
  return { inicio, fim: fim > inicio ? fim : new Date(inicio.getTime() + 60 * 60_000), diaInteiro };
}

/** Mesmo instante até o segundo (evita zerar a trava do lembrete por milissegundos). */
const mesmoSegundo = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000));

const comoSistema = <T>(ctx: Ctx, fn: () => Promise<T>) => runAsSystem(ctx.conn.teamId, fn);
const comoDono = <T>(ctx: Ctx, fn: () => Promise<T>) => runWithTeam(ctx.conn.teamId, fn, ctx.identidade);

async function apagarOcupado(ctx: Ctx, eventId: string): Promise<void> {
  await comoSistema(ctx, () => db().calendarBusyBlock.deleteMany({ where: { connectionId: ctx.conn.id, externalEventId: eventId } }));
}

const SELECT_VINCULO = {
  id: true,
  origem: true,
  etag: true,
  pendenteDesde: true,
  camposHash: true,
  canceladoNoGoogleEm: true,
  cancelarEm: true,
  externalEventId: true,
  appointment: {
    select: {
      id: true,
      status: true,
      titulo: true,
      descricao: true,
      local: true,
      inicio: true,
      fim: true,
      diaInteiro: true,
      reuniaoLink: true,
      camposComunsEm: true,
      convitesEm: true,
      convitesPorConexaoId: true,
      _count: { select: { convidados: true } },
    },
  },
} satisfies Prisma.AppointmentLinkSelect;
type VinculoComCompromisso = Prisma.AppointmentLinkGetPayload<{ select: typeof SELECT_VINCULO }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compromisso do time de onde este evento nasceu (criado pelo CRM Agro): pelo
 * `crmagroId` (só a cópia do organizador traz), pelo id que o CRM Agro dá (os 32
 * hex do compromisso — vale também na cópia de convidado) ou pelo `iCalUID`
 * do convite .ics (`<id>@crmagro`). Não é autoridade para ALTERAR nada — só
 * evita importar de novo, como compromisso novo, o que já existe.
 */
async function nasceuNoCrmAgro(ctx: Ctx, ev: EventoGoogle): Promise<boolean> {
  const candidatos = new Set<string>();
  const crmagroId = ev.extendedProperties?.private?.crmagroId;
  if (crmagroId && UUID.test(crmagroId)) candidatos.add(crmagroId.toLowerCase());
  const doId = compromissoDoIdGoogle(ev.id);
  if (doId) candidatos.add(doId);
  const doIcs = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@crmagro$/i.exec(ev.iCalUID ?? "");
  if (doIcs) candidatos.add(doIcs[1]!.toLowerCase());
  // O Google monta o iCalUID de um evento criado pela API como `<id>@google.com`:
  // a cópia de convidado pode ter OUTRO id, mas leva o UID do evento do CRM Agro.
  const doUidDoGoogle = /^([0-9a-f]{32}[0-9a-v]*)@google\.com$/i.exec(ev.iCalUID ?? "");
  const doIdDoUid = compromissoDoIdGoogle(doUidDoGoogle?.[1]?.toLowerCase());
  if (doIdDoUid) candidatos.add(doIdDoUid);
  if (!candidatos.size) return false;
  return (await comoSistema(ctx, () => db().appointment.count({ where: { id: { in: [...candidatos] } } }))) > 0;
}

async function aplicarEvento(ctx: Ctx, ev: EventoGoogle): Promise<void> {
  const { conn } = ctx;
  if (!ev?.id) return;
  // 1. Já é compromisso desta agenda?
  const vinculo = await comoSistema(ctx, () =>
    db().appointmentLink.findUnique({
      where: { connectionId_calendarId_externalEventId: { connectionId: conn.id, calendarId: "primary", externalEventId: ev.id } },
      select: SELECT_VINCULO,
    }),
  );
  // Evento criado pelo CRM Agro cujo vínculo se perdeu: refaz pelo `crmagroId`.
  // O `crmagroId` vem do Google (qualquer um escreve propriedade privada na
  // própria agenda), então NÃO é autoridade: só religa se o evento tem o id
  // que o CRM Agro dá (id do compromisso + sufixo), se a pessoa é a ORGANIZADORA
  // (não a cópia de convidado de um colega), se o compromisso é
  // DESTA pessoa (responsável) e se não está ligado a outra agenda. Senão, um
  // evento forjado poderia alterar/cancelar o compromisso de um colega.
  const crmagroId = ev.extendedProperties?.private?.crmagroId?.toLowerCase();
  if (!vinculo && crmagroId && UUID.test(crmagroId) && compromissoDoIdGoogle(ev.id) === crmagroId && ev.organizer?.self === true) {
    const religado = await religarPeloCrmAgroId(ctx, ev, crmagroId);
    if (religado) return aplicarEmVinculado(ctx, religado.vinculo, ev, religado.full);
  }
  if (vinculo) return aplicarEmVinculado(ctx, vinculo, ev);
  // 1b. Compromisso IMPORTADO deste evento que perdeu o vínculo (a pessoa
  //     desconectou e reconectou a MESMA conta: os vínculos saem em cascata, os
  //     compromissos ficam): religa em vez de importar de novo em dobro.
  if (ev.status !== "cancelled" && ev.iCalUID) {
    const religado = await religarImportadoPeloICalUID(ctx, ev);
    if (religado) return aplicarEmVinculado(ctx, religado.vinculo, ev, religado.full);
  }

  // 2. O mesmo evento já é compromisso por OUTRA agenda do time (um colega
  //    convidou esta pessoa), ou nasceu no CRM Agro (o colega convidado já o vê
  //    como convidado): nada de "Ocupado" duplicado nem compromisso em dobro.
  const doTime = await comoSistema(ctx, () => db().appointmentLink.count({ where: { externalEventId: ev.id } }));
  if (doTime || (await nasceuNoCrmAgro(ctx, ev))) {
    await apagarOcupado(ctx, ev.id);
    ctx.estat.ignorados++;
    return;
  }

  // 3. Cancelado/apagado lá: o "Ocupado" some.
  if (ev.status === "cancelled") {
    await apagarOcupado(ctx, ev.id);
    await cancelarInstancias(ctx, ev.id);
    ctx.estat.cancelados++;
    return;
  }
  // 4. Não ocupa o horário ("Disponível", aniversário, local de trabalho, ou a
  //    pessoa recusou o convite).
  const eu = (ev.attendees ?? []).find((a) => a.self);
  const recusou = eu?.responseStatus === "declined";
  if (ev.transparency === "transparent" || TIPOS_IGNORADOS.has(ev.eventType ?? "") || recusou) {
    await apagarOcupado(ctx, ev.id);
    ctx.estat.ignorados++;
    return;
  }
  const intervalo = intervaloDoEvento(ev, ctx.fuso);
  if (!intervalo || intervalo.fim.getTime() < ctx.agora.getTime() - JANELA_PASSADO_MS) {
    await apagarOcupado(ctx, ev.id);
    ctx.estat.ignorados++;
    return;
  }

  // 5. Evento com um contato DA PESSOA → compromisso completo (ver o gatilho abaixo).
  const bloco = await comoSistema(ctx, () =>
    db().calendarBusyBlock.findUnique({
      where: { connectionId_externalEventId: { connectionId: conn.id, externalEventId: ev.id } },
      select: { naoImportar: true },
    }),
  );
  if (!bloco?.naoImportar) {
    const contactId = await contatoQuePuxaOEvento(ctx, ev);
    if (contactId && (await importarComoCompromisso(ctx, ev, contactId))) return;
  }

  // 6. O resto: "Ocupado" — início, fim, id do evento e o título (só a dona vê).
  const titulo = ev.summary?.trim().slice(0, LIMITE_TITULO_IMPORTADO) || null;
  await comoSistema(ctx, () =>
    db().calendarBusyBlock.upsert({
      where: { connectionId_externalEventId: { connectionId: conn.id, externalEventId: ev.id } },
      create: {
        userId: conn.userId,
        connectionId: conn.id,
        externalEventId: ev.id,
        inicio: intervalo.inicio,
        fim: intervalo.fim,
        titulo,
      } as Prisma.CalendarBusyBlockUncheckedCreateInput,
      update: { inicio: intervalo.inicio, fim: intervalo.fim, titulo },
    }),
  );
  ctx.estat.ocupados++;
}

/**
 * Religa o evento que o CRM Agro criou e cujo vínculo se perdeu (a pessoa
 * desconectou e reconectou a MESMA conta: a conexão é outra). Só o
 * compromisso DESTA pessoa, sem outro vínculo (as outras condições estão em
 * `aplicarEvento`).
 * - O canal do convite segue com o evento religado SÓ se ele é o evento que
 *   convidou (mesmo iCalUID; sem o UID guardado, o sufixo da conexão no id):
 *   senão o Google desta agenda passaria a convidar quem entrou por outro
 *   caminho (ex.: o .ics).
 * - Quem mudou enquanto a agenda estava fora? A base é o retrato da última
 *   vez que os dois ficaram iguais (`camposHashNoGoogle`, que sobrevive à
 *   perda do vínculo). Só o CRM Agro mudou: o vínculo nasce PENDENTE com o
 *   retrato atual do evento — a mudança vai para o Google, e uma resposta de
 *   convidado (RSVP) posterior não a desfaz. Só o Google mudou (ou os dois):
 *   o vínculo nasce com a base, e a régua de sempre decide (vence a mais
 *   recente). Cancelado no CRM Agro e ativo lá: o cancelamento vale (pendente).
 */
async function religarPeloCrmAgroId(ctx: Ctx, ev: EventoGoogle, crmagroId: string): Promise<{ vinculo: VinculoComCompromisso; full: EventoGoogle } | null> {
  const dono = await comoSistema(ctx, () =>
    db().appointment.findFirst({
      where: { id: crmagroId, responsavelId: ctx.conn.userId, vinculos: { none: { cancelarEm: null } } },
      select: { convitesEm: true, convitesPorConexaoId: true, convitesICalUID: true, camposHashNoGoogle: true },
    }),
  );
  if (!dono) return null;
  return religarCompromisso(ctx, ev, crmagroId, dono, "crmagro");
}

/**
 * Compromisso IMPORTADO do Google (origem "google") que perdeu o vínculo: a
 * pessoa desconectou a agenda e reconectou a mesma conta. O evento é achado
 * pelo iCalUID que o import guardou (`convitesICalUID`; estável para o mesmo
 * evento) — não é autoridade para alterar nada além do compromisso DESTA
 * pessoa que já nasceu deste evento. Sem isto, todo evento com contato voltaria
 * como um segundo compromisso (o antigo ficaria parado, sem acompanhar o Google).
 */
async function religarImportadoPeloICalUID(ctx: Ctx, ev: EventoGoogle): Promise<{ vinculo: VinculoComCompromisso; full: EventoGoogle } | null> {
  const { conn } = ctx;
  // O índice único (time, evento) pertence a quem já tem o evento.
  if (await comoSistema(ctx, () => db().appointmentLink.count({ where: { externalEventId: ev.id } }))) return null;
  // Todas as instâncias de uma série têm o MESMO iCalUID: nelas o instante de
  // início também tem de bater, senão uma instância religaria o compromisso de outra.
  const inicioDaInstancia = ev.recurringEventId ? (intervaloDoEvento(ev, ctx.fusoDoTime)?.inicio ?? null) : undefined;
  if (inicioDaInstancia === null) return null;
  const dono = await comoSistema(ctx, () =>
    db().appointment.findFirst({
      where: {
        origem: "google",
        responsavelId: conn.userId,
        convitesICalUID: ev.iCalUID,
        vinculos: { none: {} },
        ...(inicioDaInstancia ? { inicio: inicioDaInstancia } : {}),
      },
      select: { id: true, convitesEm: true, convitesPorConexaoId: true, convitesICalUID: true, camposHashNoGoogle: true },
    }),
  );
  if (!dono) return null;
  // Organizado pela pessoa: o CRM Agro também edita lá; convidada: só lê (como na importação).
  const full = await comAcesso(conn, (t) => obterEvento(t, "primary", ev.id));
  return religarCompromisso(ctx, ev, dono.id, dono, full.organizer?.self === true ? "google" : "convite", full);
}

/** Cria o vínculo do compromisso com o evento (religar) — o comum de `religarPeloCrmAgroId` e do importado. */
async function religarCompromisso(
  ctx: Ctx,
  ev: EventoGoogle,
  appointmentId: string,
  dono: { convitesEm: Date | null; convitesPorConexaoId: string | null; convitesICalUID: string | null; camposHashNoGoogle: string | null },
  origem: "crmagro" | "google" | "convite",
  lido?: EventoGoogle,
): Promise<{ vinculo: VinculoComCompromisso; full: EventoGoogle }> {
  const { conn, agora } = ctx;
  const full = lido ?? (await comAcesso(conn, (t) => obterEvento(t, "primary", ev.id)));
  const outraConexao = dono.convitesEm && dono.convitesPorConexaoId && dono.convitesPorConexaoId !== conn.id ? dono.convitesPorConexaoId : null;
  const eraOCanal =
    outraConexao !== null &&
    (dono.convitesICalUID
      ? full.iCalUID === dono.convitesICalUID
      : ev.id.slice(32, 40) === outraConexao.replace(/-/g, "").slice(0, 8).toLowerCase());
  const escreveNoGoogle = origem !== "convite";
  const vinculo = await comoSistema(ctx, async () => {
    if (eraOCanal) {
      await db().appointment.update({ where: { id: appointmentId }, data: { convitesPorConexaoId: conn.id, convitesICalUID: full.iCalUID ?? dono.convitesICalUID } });
    }
    const base = dono.camposHashNoGoogle;
    const doGoogle = hashDosCamposComuns(full);
    const doCrmAgro = await retratoParaOGoogle(appointmentId, conn, full, ctx.fusoDoTime);
    const soOCrmAgro = base !== null && doGoogle === base && doCrmAgro !== null && doCrmAgro.hash !== base;
    const crmagroCancelou = Boolean(doCrmAgro?.cancelado) && full.status !== "cancelled";
    return db().appointmentLink.create({
      data: {
        appointmentId,
        connectionId: conn.id,
        calendarId: "primary",
        externalEventId: ev.id,
        origem,
        iCalUID: full.iCalUID ?? null,
        externalUpdatedAt: full.updated ? new Date(full.updated) : null,
        camposHash: soOCrmAgro ? doGoogle : base,
        sincronizadoEm: agora,
        // Só quem o CRM Agro escreve no Google fica com a mudança pendente.
        pendenteDesde: escreveNoGoogle && (soOCrmAgro || crmagroCancelou) ? agora : null,
      } as Prisma.AppointmentLinkUncheckedCreateInput,
      select: SELECT_VINCULO,
    });
  });
  return { vinculo, full };
}

/**
 * Série recorrente apagada (ou cortada em "esta e as seguintes"): o Google
 * pode avisar só o evento-mãe (`<id>`), e as instâncias são `<id>_<data>`.
 * Os "Ocupado" delas saem e os compromissos ligados são cancelados.
 */
async function cancelarInstancias(ctx: Ctx, eventId: string): Promise<void> {
  const prefixo = `${eventId}_`;
  const blocos = (
    await comoSistema(ctx, () =>
      db().calendarBusyBlock.findMany({ where: { connectionId: ctx.conn.id, externalEventId: { startsWith: prefixo } }, select: { id: true, externalEventId: true } }),
    )
  ).filter((b) => b.externalEventId.startsWith(prefixo));
  if (blocos.length) await comoSistema(ctx, () => db().calendarBusyBlock.deleteMany({ where: { id: { in: blocos.map((b) => b.id) } } }));
  const vinculos = (
    await comoSistema(ctx, () =>
      db().appointmentLink.findMany({ where: { connectionId: ctx.conn.id, externalEventId: { startsWith: prefixo } }, select: SELECT_VINCULO }),
    )
  ).filter((v) => v.externalEventId.startsWith(prefixo));
  for (const v of vinculos) await aplicarEmVinculado(ctx, v, { id: v.externalEventId, status: "cancelled" });
}

/**
 * O gatilho da importação completa (decisão 4, revisão do #169): quem está
 * de fora não pode puxar um evento pessoal inteiro para o CRM.
 * - só contatos cujo DONO é a pessoa da agenda (não os compartilhados, nem os
 *   que ela vê por "ver tudo" — senão um colega criaria um contato com o
 *   e-mail do médico dela e passaria a ver a consulta);
 * - evento organizado por ela: basta um convidado ser contato dela;
 * - organizado por outra pessoa: só se ela ACEITOU (ou "talvez") e se quem
 *   organizou é o próprio contato ou um colega do time — convite de terceiro
 *   que só cita o contato vira "Ocupado".
 */
async function contatoQuePuxaOEvento(ctx: Ctx, ev: EventoGoogle): Promise<string | null> {
  const organizadoraSouEu = ev.organizer?.self === true || !ev.organizer?.email;
  const organizador = organizadoraSouEu ? null : normalizarEmail(ev.organizer?.email);
  if (!organizadoraSouEu) {
    const minha = (ev.attendees ?? []).find((a) => a.self)?.responseStatus;
    if (minha !== "accepted" && minha !== "tentative") return null;
  }
  const emails = [
    ...(ev.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => normalizarEmail(a.email)),
    organizador,
  ].filter((e): e is string => Boolean(e));
  if (!emails.length) return null;
  const contatos = await comoSistema(ctx, () => contatosDoDono(emails, ctx.conn.userId));
  if (!organizadoraSouEu) {
    if (!organizador) return null;
    const doContato = contatos.get(organizador);
    if (doContato) return doContato;
    const colegas = await comoSistema(ctx, () => colegasPorEmail([organizador]));
    if (!colegas.has(organizador)) return null;
  }
  for (const e of emails) {
    const c = contatos.get(e);
    if (c) return c;
  }
  return null;
}

/** Contatos (por e-mail) cujo dono é a pessoa — nada de compartilhado nem "ver tudo". */
async function contatosDoDono(emails: string[], ownerId: string): Promise<Map<string, string>> {
  const lista = [...new Set(emails)].slice(0, 200);
  const rows = await db().channelIdentifier.findMany({
    where: { ...ondeIdentificadorExato(getCurrentTeamId() ?? "", "email", lista), contact: { ownerId } },
    select: { valor: true, valorCifrado: true, contactId: true },
    orderBy: { createdAt: "asc" },
  });
  const mapa = new Map<string, string>();
  for (const r of rows) {
    const valor = valorDe(r);
    if (valor && !mapa.has(valor)) mapa.set(valor, r.contactId);
  }
  return mapa;
}

/** Campos comuns vindos do evento COMPLETO do Google (dia inteiro no fuso do TIME). */
function camposDoGoogle(full: EventoGoogle, fusoTime: string) {
  const intervalo = intervaloDoEvento(full, fusoTime);
  return {
    titulo: (full.summary ?? "").trim().slice(0, LIMITE_TITULO_IMPORTADO) || null,
    descricao: full.description ? full.description.slice(0, LIMITE_DESCRICAO_IMPORTADA) : null,
    local: (full.location ?? "").trim().slice(0, LIMITE_LOCAL_IMPORTADO) || null,
    intervalo,
    reuniaoLink: linkDaReuniao(full),
  };
}

/** Convidados do evento do Google (sem a própria pessoa nem salas), com colega/contato casados. */
async function convidadosDoGoogle(ctx: Ctx, full: EventoGoogle): Promise<ConvidadoNormalizado[]> {
  const vistos = new Map<string, ConvidadoNormalizado>();
  for (const a of full.attendees ?? []) {
    if (a.self || a.resource) continue;
    const email = normalizarEmail(a.email);
    if (!email || vistos.has(email)) continue;
    vistos.set(email, { email, nome: a.displayName?.trim().slice(0, 200) || null, userId: null, contactId: null, resposta: a.responseStatus || "needsAction" });
    // O mesmo teto da edição (convidados.ts): o que entra aqui sempre salva de novo.
    if (vistos.size >= MAX_CONVIDADOS_TOTAL) break;
  }
  const emails = [...vistos.keys()];
  const [contatos, colegas] = await comoDono(ctx, async () => Promise.all([contatosPorEmail(emails), colegasPorEmail(emails)]));
  for (const c of vistos.values()) {
    const ct = contatos.get(c.email);
    if (ct) c.contactId = ct.contactId;
    const colega = colegas.get(c.email);
    if (colega) c.userId = colega.userId;
  }
  return [...vistos.values()];
}

/**
 * Evento com contato → compromisso completo, ligado ao contato (atômico:
 * compromisso + convidados + vínculo). O índice único (time, id do evento)
 * garante UM compromisso por evento no time: duas agendas convidadas para o
 * mesmo evento, sincronizando juntas, não duplicam (a segunda desiste).
 * Devolve false quando não importou (virou "Ocupado" ou já existe).
 */
async function importarComoCompromisso(ctx: Ctx, ev: EventoGoogle, contactId: string): Promise<boolean> {
  const { conn } = ctx;
  const full = await comAcesso(conn, (t) => obterEvento(t, "primary", ev.id));
  if (full.status === "cancelled") return false;
  const campos = camposDoGoogle(full, ctx.fusoDoTime);
  if (!campos.intervalo) return false;
  const convidados = await convidadosDoGoogle(ctx, full);
  const atualizadoEm = full.updated ? new Date(full.updated) : ctx.agora;
  const organizadora = full.organizer?.self === true;
  try {
    await comoSistema(ctx, async () => {
      requireCan("agenda.write");
      await db().appointment.create({
        data: {
          titulo: campos.titulo ?? "Reunião",
          descricao: campos.descricao,
          tipo: campos.reuniaoLink ? "reuniao_online" : "reuniao",
          inicio: campos.intervalo!.inicio,
          fim: campos.intervalo!.fim,
          diaInteiro: campos.intervalo!.diaInteiro,
          local: campos.local,
          contactId,
          responsavelId: conn.userId,
          origem: "google",
          reuniaoLink: campos.reuniaoLink,
          reuniaoProvedor: campos.reuniaoLink ? provedorDaReuniao(campos.reuniaoLink) : null,
          camposComunsEm: atualizadoEm,
          camposHashNoGoogle: hashDosCamposComuns(full),
          // Os convidados já foram convidados pelo evento DESTA agenda (o CRM Agro
          // nunca manda outro convite a eles por outro caminho).
          ...(convidados.length ? { convitesEm: atualizadoEm, convitesPorConexaoId: conn.id, convitesICalUID: full.iCalUID ?? null } : {}),
          // Só a dona vê até confirmar que é de trabalho ("Manter no CRM Agro").
          privadoAteConfirmar: true,
          // Criações aninhadas não passam pela injeção do time: teamId explícito.
          convidados: {
            create: convidados.map((c) => ({
              teamId: conn.teamId,
              email: c.email,
              nome: c.nome,
              userId: c.userId,
              contactId: c.contactId,
              resposta: c.resposta ?? "needsAction",
            })),
          },
          vinculos: {
            create: {
              teamId: conn.teamId,
              connectionId: conn.id,
              calendarId: "primary",
              externalEventId: ev.id,
              iCalUID: full.iCalUID ?? null,
              etag: full.etag ?? ev.etag ?? null,
              externalUpdatedAt: atualizadoEm,
              camposHash: hashDosCamposComuns(full),
              // Organizado pela pessoa: o CRM Agro também edita lá. Convidada: só lê.
              origem: organizadora ? "google" : "convite",
              sincronizadoEm: ctx.agora,
            },
          },
        } as Prisma.AppointmentUncheckedCreateInput,
        select: { id: true },
      });
      // Era "Ocupado" (desta ou de outra agenda do time): agora é compromisso.
      await db().calendarBusyBlock.deleteMany({ where: { externalEventId: ev.id } });
    });
  } catch (e) {
    // Outra agenda do time importou o mesmo evento no mesmo instante: fica o dela.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await apagarOcupado(ctx, ev.id);
      ctx.estat.ignorados++;
      return true;
    }
    throw e;
  }
  ctx.estat.compromissos++;
  return true;
}

/**
 * A lista de convidados do evento do Google (desta conexão) é a do
 * compromisso? Só quando o convite saiu POR ELE — ou ainda não saiu por lugar
 * nenhum e o Google tem convidados (a pessoa convidou direto lá). Evento que
 * foi SEM convidados (convite pelo .ics do time ou por outra agenda) não apaga
 * os convidados do CRM Agro.
 */
function listaDoGoogleVale(a: VinculoComCompromisso["appointment"], connectionId: string, doGoogle: number): boolean {
  if (a.convitesEm) return a.convitesPorConexaoId === connectionId;
  return doGoogle > 0 || a._count.convidados === 0;
}

/**
 * Cancelamento vindo do Google (decisão 6): cancelado no CRM Agro, fica no
 * histórico. O que já aconteceu (concluído, ou com o horário no passado) não
 * muda: apagar a série ou um evento antigo lá é limpeza da agenda, não
 * cancelamento — o histórico do contato e os números do painel ficam.
 */
async function cancelarPeloGoogle(ctx: Ctx, v: VinculoComCompromisso, etag: string | null | undefined): Promise<void> {
  const a = v.appointment;
  const { agora } = ctx;
  const jaAconteceu = a.status === "concluido" || (a.fim ?? a.inicio).getTime() < agora.getTime();
  const veioDoGoogle = a.status !== "cancelado" && !jaAconteceu;
  await comoSistema(ctx, async () => {
    if (veioDoGoogle) {
      await db().appointment.update({ where: { id: a.id }, data: { status: "cancelado", camposComunsEm: agora } });
    }
    await db().appointmentLink.update({
      where: { id: v.id },
      data: {
        etag: etag ?? v.etag,
        pendenteDesde: null,
        tentativas: 0,
        sincronizadoEm: agora,
        // Guarda QUEM cancelou: só o cancelamento do Google é desfeito por ele.
        ...(veioDoGoogle ? { canceladoNoGoogleEm: agora } : {}),
      },
    });
    // Convidados que não estão no evento do Google (convite pelo .ics): o
    // cancelamento só chega a eles pelo .ics.
    if (veioDoGoogle && a._count.convidados && a.convitesEm && a.convitesPorConexaoId !== ctx.conn.id) {
      await avisarConvidadosPeloIcs(a.id, { status: "cancelado" });
    }
  });
  if (veioDoGoogle) ctx.estat.cancelados++;
  else ctx.estat.ignorados++;
}

/** A escrita da sincronização perdeu a corrida para um salvar no CRM Agro (CAS). */
class CompromissoMudouNoMeio extends Error {
  constructor() {
    super("CompromissoMudouNoMeio");
    this.name = "CompromissoMudouNoMeio";
  }
}

/** Evento que já é compromisso: cancelamento, eco, conflito e atualização. */
async function aplicarEmVinculado(ctx: Ctx, v: VinculoComCompromisso, ev: EventoGoogle, fullLido?: EventoGoogle): Promise<void> {
  const a = v.appointment;
  const { conn, agora } = ctx;
  // Vínculo aposentado (o compromisso mudou de responsável e o evento desta
  // agenda está na fila para ser cancelado): nada daqui chega ao compromisso.
  // Se já foi apagado lá, o trabalho acabou.
  if (v.cancelarEm) {
    if (ev.status === "cancelled") await comoSistema(ctx, () => db().appointmentLink.deleteMany({ where: { id: v.id, cancelarEm: { not: null } } }));
    ctx.estat.ignorados++;
    return;
  }
  if (ev.status === "cancelled") return cancelarPeloGoogle(ctx, v, ev.etag);
  // Eco do que o próprio CRM Agro mandou (mesmo etag): nada mudou lá.
  if (ev.etag && v.etag === ev.etag) {
    ctx.estat.ignorados++;
    return;
  }
  const full = fullLido ?? (await comAcesso(conn, (t) => obterEvento(t, "primary", ev.id)));
  if (full.status === "cancelled") return cancelarPeloGoogle(ctx, v, full.etag ?? ev.etag);
  const googleEm = full.updated ? new Date(full.updated) : ev.updated ? new Date(ev.updated) : agora;
  const hash = hashDosCamposComuns(full);
  const campos = camposDoGoogle(full, ctx.fusoDoTime);
  const convidados = await convidadosDoGoogle(ctx, full);
  const escreveNoGoogle = v.origem !== "convite";
  const crmagroPendente = escreveNoGoogle && v.pendenteDesde !== null;
  // Só resposta de convidado / Meet criado (o `updated` andou, os campos comuns não).
  const soNaoComuns = v.camposHash !== null && v.camposHash === hash;
  // Decisão 5: vale a alteração mais recente dos campos comuns.
  const crmagroMaisNovo = a.camposComunsEm > googleEm;
  const aplicarComuns = !soNaoComuns && !crmagroMaisNovo;

  // Sempre: respostas (RSVP), o link da reunião que o Google acabou de criar e o etag.
  const meet = campos.reuniaoLink && campos.reuniaoLink !== a.reuniaoLink ? campos.reuniaoLink : null;
  const lidos = { etag: full.etag ?? ev.etag ?? null, iCalUID: full.iCalUID ?? null, externalUpdatedAt: googleEm, sincronizadoEm: agora };

  if (!aplicarComuns) {
    await comoSistema(ctx, async () => {
      await atualizarRespostas(
        a.id,
        convidados.map((c) => ({ email: c.email, resposta: c.resposta ?? "needsAction" })),
      );
      if (meet && !a.reuniaoLink) await db().appointment.update({ where: { id: a.id }, data: { reuniaoLink: meet, reuniaoProvedor: provedorDaReuniao(meet) } });
      await db().appointmentLink.update({
        where: { id: v.id },
        data: {
          ...lidos,
          // A versão do CRM Agro é a mais nova e não está lá: reenvia (o pendente fica).
          ...(escreveNoGoogle && !soNaoComuns && crmagroMaisNovo && !v.pendenteDesde ? { pendenteDesde: agora } : {}),
        },
      });
    });
    ctx.estat.ignorados++;
    return;
  }

  // A versão do Google vale: é também a base da comparação ao religar.
  const data: Prisma.AppointmentUncheckedUpdateInput = { camposComunsEm: googleEm, camposHashNoGoogle: hash };
  if (campos.titulo && campos.titulo !== a.titulo) data.titulo = campos.titulo;
  if ((campos.descricao ?? null) !== (a.descricao ?? null)) data.descricao = campos.descricao;
  if ((campos.local ?? null) !== (a.local ?? null)) data.local = campos.local;
  if (campos.intervalo) {
    if (!mesmoSegundo(campos.intervalo.inicio, a.inicio)) data.inicio = campos.intervalo.inicio;
    if (!mesmoSegundo(campos.intervalo.fim, a.fim)) data.fim = campos.intervalo.fim;
    if (campos.intervalo.diaInteiro !== a.diaInteiro) data.diaInteiro = campos.intervalo.diaInteiro;
  }
  if (meet) {
    data.reuniaoLink = meet;
    data.reuniaoProvedor = provedorDaReuniao(meet);
  }
  // Restaurado no Google depois de cancelado: volta a valer — mas só desfaz o
  // cancelamento que VEIO do Google, ou o de um evento que o CRM Agro organiza e
  // que já chegou lá. Cancelado no CRM Agro num evento em que a pessoa é só
  // convidada (nunca vai ao Google) não é reaberto por uma mudança de lá.
  if (a.status === ("cancelado" as AppointmentStatus) && (v.canceladoNoGoogleEm !== null || (escreveNoGoogle && !crmagroPendente))) {
    data.status = "pendente";
  }
  // Cancelamento feito no CRM Agro que ainda não chegou ao Google (5xx, conta em
  // "Reconectar"): continua valendo mesmo com uma mudança mais nova lá — o
  // vínculo fica PENDENTE e o worker cancela no Google (nunca "cancelado"
  // aqui e ativo lá).
  const cancelamentoPendente = a.status === ("cancelado" as AppointmentStatus) && crmagroPendente && data.status === undefined;
  // A lista de convidados deste evento vale? (Evento que foi sem convidados
  // — convite pelo .ics — não apaga os do CRM Agro.)
  const trocaConvidados = listaDoGoogleVale(a, conn.id, convidados.length);
  // A pessoa convidou direto no Google (nenhum convite tinha saído): o canal passa a ser este evento.
  if (trocaConvidados && !a.convitesEm && convidados.length) {
    data.convitesEm = googleEm;
    data.convitesPorConexaoId = conn.id;
    data.convitesICalUID = full.iCalUID ?? null;
  }
  try {
    await comoSistema(ctx, async () => {
      requireCan("agenda.write");
      // CAS: um salvar no CRM Agro entre a leitura e esta escrita ganha (a
      // próxima rodada compara de novo) — a lista velha do Google nunca
      // apaga um convidado recém-incluído.
      await db().$transaction(async (tx) => {
        // Contato, tipo, lembrete e responsável: só do CRM Agro — não entram aqui.
        const { count } = await tx.appointment.updateMany({ where: { id: a.id, camposComunsEm: a.camposComunsEm }, data });
        if (count !== 1) throw new CompromissoMudouNoMeio();
        if (trocaConvidados) await substituirConvidados(a.id, conn.teamId, convidados, tx);
        await tx.appointmentLink.update({
          where: { id: v.id },
          data: {
            ...lidos,
            camposHash: hash,
            ultimoErro: null,
            canceladoNoGoogleEm: null,
            ...(cancelamentoPendente ? {} : { pendenteDesde: null, tentativas: 0 }),
          },
        });
      });
      if (!trocaConvidados) {
        // Só as respostas de quem também está no evento de lá (ninguém entra nem sai).
        await atualizarRespostas(
          a.id,
          convidados.map((c) => ({ email: c.email, resposta: c.resposta ?? "needsAction" })),
        );
        // Os convidados do .ics não recebem a atualização do Google: vai o .ics
        // (mesmo UID, SEQUENCE nova) com o horário/título/local novos.
        const visivel = ["titulo", "descricao", "local", "inicio", "fim", "diaInteiro", "status"].some((k) => k in data);
        const statusFinal = (data.status as AppointmentStatus | undefined) ?? a.status;
        if (visivel && a._count.convidados && a.convitesEm && statusFinal !== "cancelado") {
          await avisarConvidadosPeloIcs(a.id, { status: data.status === "pendente" ? "reaberto" : undefined });
        }
      }
    });
  } catch (e) {
    if (e instanceof CompromissoMudouNoMeio) {
      ctx.estat.ignorados++;
      return;
    }
    throw e;
  }
  ctx.estat.atualizados++;
}

// ---------------------------------------------------------------------------
// Push (events.watch)
// ---------------------------------------------------------------------------

/** Token do canal: HMAC do id (não precisa guardar; a rota confere recalculando). */
export function tokenDoCanal(canalId: string): string {
  return createHmac("sha256", `crmagro-google-agenda-canal:${env.AUTH_SECRET}`).update(canalId).digest("base64url");
}

const TTL_CANAL_S = 7 * 24 * 60 * 60;

/**
 * Abre (ou renova, faltando menos de 24 h) o canal de push da agenda. Push
 * desligado: para o canal que houver e limpa os campos (senão a manutenção
 * veria "canal vencendo" para sempre e sincronizaria a cada minuto). Falha no
 * `watch`: espera própria (`canalTentarEm`), sem virar polling de 1 minuto.
 * Nunca lança (o polling de reserva segue valendo).
 */
async function garantirCanal(
  ctx: Ctx,
  sync: { id: string; canalId: string | null; canalResourceId: string | null; canalExpiraEm: Date | null; canalTentarEm: Date | null },
): Promise<void> {
  const limpar = () =>
    comoSistema(ctx, () =>
      db().calendarSync.update({ where: { id: sync.id }, data: { canalId: null, canalResourceId: null, canalExpiraEm: null, canalTentarEm: null } }),
    );
  try {
    if (!pushDaAgendaHabilitado()) {
      if (sync.canalId || sync.canalExpiraEm) {
        if (sync.canalId && sync.canalResourceId) {
          await comAcesso(ctx.conn, (t) => pararCanal(t, { id: sync.canalId!, resourceId: sync.canalResourceId! })).catch(() => {});
        }
        await limpar();
      }
      return;
    }
    if (sync.canalId && sync.canalExpiraEm && sync.canalExpiraEm.getTime() > ctx.agora.getTime() + DIA) return;
    if (sync.canalTentarEm && sync.canalTentarEm > ctx.agora) return;
    const id = randomUUID();
    const r = await comAcesso(ctx.conn, (t) =>
      assistirAgenda(t, "primary", { id, token: tokenDoCanal(id), address: `${urlPublicaDoApp()}/api/integracoes/google/notificacao`, ttlSeg: TTL_CANAL_S }),
    );
    await comoSistema(ctx, () =>
      db().calendarSync.update({ where: { id: sync.id }, data: { canalId: id, canalResourceId: r.resourceId, canalExpiraEm: r.expiraEm, canalTentarEm: null } }),
    );
    // O canal antigo continuaria avisando até vencer: para.
    if (sync.canalId && sync.canalResourceId) {
      await comAcesso(ctx.conn, (t) => pararCanal(t, { id: sync.canalId!, resourceId: sync.canalResourceId! })).catch(() => {});
    }
  } catch (e) {
    logger.warn({ connectionId: ctx.conn.id, err: erroSeguro(e) }, "[agenda-google] canal de push não abriu (fica o polling)");
    await comoSistema(ctx, () =>
      db().calendarSync.update({ where: { id: sync.id }, data: { canalTentarEm: new Date(ctx.agora.getTime() + sorteio(ESPERA_CANAL_MS)) } }),
    ).catch(() => {});
  }
}

export type AvisoDoGoogle = { canalId?: string | null; token?: string | null; resourceId?: string | null; estado?: string | null };

/**
 * Aviso do Google (POST sem corpo, só cabeçalhos). Valida o canal e o token
 * ANTES de tudo e só enfileira a sincronização — responde rápido sempre.
 * Canal desconhecido (conexão apagada, canal antigo) é ignorado.
 */
export async function receberAvisoDoGoogle(h: AvisoDoGoogle): Promise<"sincronizar" | "handshake" | "ignorado"> {
  const canalId = h.canalId ?? "";
  const token = h.token ?? "";
  if (!canalId || !token || canalId.length > 64 || token.length > 256) return "ignorado";
  const certo = Buffer.from(tokenDoCanal(canalId));
  const recebido = Buffer.from(token);
  if (certo.length !== recebido.length || !timingSafeEqual(certo, recebido)) return "ignorado";
  // Sem sessão nem time (é o Google chamando): acha a agenda pelo id do canal, que é único.
  const s = await basePrisma.calendarSync.findUnique({
    where: { canalId },
    select: { connectionId: true, canalResourceId: true, connection: { select: { status: true } } },
  });
  if (!s || (h.resourceId && s.canalResourceId && s.canalResourceId !== h.resourceId)) return "ignorado";
  if (h.estado === "sync") return "handshake";
  if (s.connection.status !== "connected") return "ignorado";
  // Se uma sincronização desta agenda está correndo, ela vê a marca no fim e roda de novo.
  await redisEstado()
    .set(chaveSujo(s.connectionId), "1", "EX", 3600)
    .catch(() => {});
  await enfileirarSyncGoogle(s.connectionId);
  return "sincronizar";
}
