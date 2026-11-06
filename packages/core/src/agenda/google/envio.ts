import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppointmentStatus, AppointmentType, Prisma } from "@prisma/client";
import { basePrisma, db, runAsSystem } from "@crmagro/db";
import { sendCalendarInvite } from "../../email/service";
import { logger } from "../../logger/index";
import { temModulo } from "../../auth/modulos";
import { DEFAULT_TZ, zonedParts } from "../../motor-do-dia/tz";
import { normalizarEmail } from "../convidados";
import {
  atualizarEvento,
  cancelarEvento,
  ESCOPO_AGENDA,
  GoogleApiErro,
  GoogleAutorizacaoInvalida,
  inserirEvento,
  obterEvento,
  type ConvidadoGoogle,
  type EventoGoogle,
  type EventoParaGoogle,
  type HorarioGoogle,
} from "./cliente";
import {
  accessTokenDaConexao,
  agendaGoogleLiberadaPara,
  ConexaoGoogleInativa,
  filtroDeConexoesLiberadas,
  googleAgendaConfigurada,
  PROVEDOR_GOOGLE,
  type ConexaoComToken,
} from "./conexao";
import { enfileirarSyncGoogle } from "./fila";

/**
 * CRM Agro → Google (fase 1). Depois de salvar um compromisso, o serviço da
 * Agenda chama `propagarCompromisso`:
 *
 * - Responsável com a Agenda Google conectada: cria/atualiza/cancela o evento
 *   NA AGENDA DELE (ele é o organizador) e o Google Meet quando o tipo é
 *   "reunião online". O id do evento é o id do compromisso sem hífens + 8 hex
 *   da conexão (base32hex válido, ÚNICO por agenda): repetir a criação não
 *   duplica (409 → confere e atualiza) e a troca de responsável nunca bate na
 *   cópia de convidado que a agenda nova já tem. O evento leva `crmagroId` numa
 *   propriedade privada.
 * - Quem manda o CONVITE pelo Google é só o dono da agenda (revisão do #169):
 *   os convidados vão no evento, com `sendUpdates=all`, apenas se quem fez a
 *   última alteração que o convidado vê (`alteradoPorId`) é o próprio
 *   responsável — ou se o convite já saiu por ESTE evento. Colega, gestor ou a
 *   automação criando/transferindo para outra pessoa: o evento entra na agenda
 *   do responsável SEM convidados (`sendUpdates=none`) e o convite sai pelo
 *   .ics da caixa do time, como antes do Google. Assim ninguém usa a conta
 *   Google de outra pessoa para convidar quem quiser.
 * - Um canal de convite por compromisso (`convitesEm` + `convitesPorConexaoId`):
 *   quem já recebeu o .ics não recebe um segundo convite do Google (ex.: a
 *   pessoa reconecta depois de "Reconectar"), e quem foi convidado pelo evento
 *   de uma agenda não é convidado de novo pela de outra. Se aquele Google sai
 *   de cena (desconectar, excluir a pessoa), o .ics seguinte usa o UID do
 *   evento que convidou (`convitesICalUID`): o cliente de e-mail atualiza a
 *   mesma entrada, sem evento em dobro.
 * - Troca de responsável: o evento na agenda do antigo organizador é
 *   cancelado de forma DURÁVEL (vínculo "aposentado", `cancelarEm`): Google
 *   fora do ar ou conta em "Reconectar" deixam o cancelamento na fila do worker.
 * - Sem agenda conectada (ou compromisso "do time", sem responsável, ou a
 *   integração desligada no .env): o convite .ics por e-mail — com vários
 *   convidados, com o cancelamento (METHOD:CANCEL) e com a hora no fuso do time.
 * - Best-effort: o Google fora do ar não derruba o salvar. O vínculo fica
 *   "pendente" e o worker tenta de novo (`enviarPendentesAoGoogle`).
 */

export type Mudancas = {
  /** Compromisso acabou de ser criado. */
  criado?: boolean;
  /** Campos que o convidado vê mudaram (título, horário, local, descrição, tipo). */
  comuns: boolean;
  /** Convidados que entraram agora (só eles recebem o .ics se nada mais mudou). */
  convidadosNovos: string[];
  /** Mudança de status que o convidado precisa saber. */
  status?: "cancelado" | "reaberto";
  /** Rodada do worker: só o Google, nunca o .ics. */
  apenasGoogle?: boolean;
};

const SELECT_CONEXAO = {
  id: true,
  teamId: true,
  userId: true,
  status: true,
  credentials: true,
  accessTokenExpiraEm: true,
  scopes: true,
  createdAt: true,
  user: { select: { email: true, role: true, modulos: true, desativadoEm: true } },
} satisfies Prisma.OAuthConnectionSelect;

const SELECT_ENVIO = {
  id: true,
  teamId: true,
  titulo: true,
  descricao: true,
  tipo: true,
  inicio: true,
  fim: true,
  status: true,
  local: true,
  diaInteiro: true,
  reuniaoLink: true,
  origem: true,
  responsavelId: true,
  createdAt: true,
  camposComunsEm: true,
  alteradoPorId: true,
  convitesEm: true,
  convitesPorConexaoId: true,
  convitesICalUID: true,
  convidados: { select: { email: true, nome: true }, orderBy: { createdAt: "asc" } },
  // Vínculo aposentado (troca de responsável, cancelamento na fila) nunca é destino.
  vinculos: {
    where: { cancelarEm: null },
    select: {
      id: true,
      calendarId: true,
      externalEventId: true,
      origem: true,
      pendenteDesde: true,
      sincronizadoEm: true,
      tentativas: true,
      externalUpdatedAt: true,
      connection: { select: SELECT_CONEXAO },
    },
  },
} satisfies Prisma.AppointmentSelect;

type Compromisso = {
  id: string;
  teamId: string;
  titulo: string;
  descricao: string | null;
  tipo: AppointmentType;
  inicio: Date;
  fim: Date | null;
  status: AppointmentStatus;
  local: string | null;
  diaInteiro: boolean;
  reuniaoLink: string | null;
  /** "crmagro" (criado aqui) ou "google" (importado da agenda da pessoa). */
  origem: string;
  responsavelId: string | null;
  createdAt: Date;
  camposComunsEm: Date;
  alteradoPorId: string | null;
  convitesEm: Date | null;
  convitesPorConexaoId: string | null;
  convitesICalUID: string | null;
  convidados: { email: string; nome: string | null }[];
  vinculos: Vinculo[];
};
type Conexao = ConexaoComToken & { scopes: string[]; createdAt: Date; user: { email: string; role: string; modulos: string[]; desativadoEm: Date | null } };
type Vinculo = {
  id: string;
  calendarId: string;
  externalEventId: string;
  origem: string;
  pendenteDesde: Date | null;
  sincronizadoEm: Date | null;
  tentativas: number;
  externalUpdatedAt: Date | null;
  connection: Conexao;
};

const UMA_HORA = 60 * 60_000;

/**
 * Id do evento no Google: o uuid do compromisso sem hífens + os 8 primeiros
 * hex da conexão. Só [0-9a-f]: base32hex válido. Único POR AGENDA — o mesmo
 * compromisso em outra agenda (troca de responsável) ganha outro id, e a cópia
 * de convidado que a agenda nova já tinha nunca colide com o evento novo.
 */
export const idDoEventoGoogle = (appointmentId: string, connectionId: string) =>
  `${appointmentId.replace(/-/g, "")}${connectionId.replace(/-/g, "").slice(0, 8)}`.toLowerCase();

/**
 * Compromisso de origem de um id que o CRM Agro deu (os 32 primeiros hex), ou
 * null. Serve para reconhecer, em QUALQUER agenda (inclusive a cópia de
 * convidado, que não traz a propriedade privada), o evento que nasceu no CRM Agro.
 */
export function compromissoDoIdGoogle(eventId: string | null | undefined): string | null {
  const m = /^([0-9a-f]{32})[0-9a-v]*$/.exec(String(eventId ?? ""));
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fuso do time (TeamConfig), com o padrão de São Paulo. */
export async function fusoDoTime(teamId: string): Promise<string> {
  const cfg = await basePrisma.teamConfig.findUnique({ where: { teamId }, select: { timezone: true } });
  return cfg?.timezone || DEFAULT_TZ;
}

const dataNoFuso = (d: Date, tz: string) => {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/**
 * Link da videochamada que o Google devolveu. Só `https://` (o evento pode vir
 * de fora, com qualquer coisa no campo): o resto é descartado.
 */
export function linkDaReuniao(ev: Pick<EventoGoogle, "hangoutLink" | "conferenceData">): string | null {
  const bruto = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null;
  if (!bruto) return null;
  try {
    const u = new URL(bruto);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "meet" só para o domínio do Google Meet; o resto é "outro" (a tela mostra o endereço). */
export function provedorDaReuniao(link: string): "meet" | "outro" {
  try {
    return new URL(link).hostname === "meet.google.com" ? "meet" : "outro";
  } catch {
    return "outro";
  }
}

const instanteDoHorario = (h: HorarioGoogle | undefined) => (h?.dateTime ? new Date(h.dateTime).toISOString() : (h?.date ?? ""));
const convidadoDeVerdade = (x: ConvidadoGoogle) => !x.self && !x.resource;

/**
 * Impressão digital dos CAMPOS COMUNS de um evento do Google (título,
 * descrição, local, horário e os e-mails dos convidados). Resposta de
 * convidado (RSVP) e a criação do Meet mudam o `updated` do Google, mas não
 * mudam isto: a sincronização usa a diferença para saber se o Google mexeu
 * mesmo em algo que o convidado vê (decisão 5).
 */
export function hashDosCamposComuns(ev: EventoGoogle): string {
  const convidados = (ev.attendees ?? [])
    .filter(convidadoDeVerdade)
    .map((x) => normalizarEmail(x.email))
    .filter((e): e is string => Boolean(e))
    .sort();
  const base = [ev.summary ?? "", ev.description ?? "", ev.location ?? "", instanteDoHorario(ev.start), instanteDoHorario(ev.end), convidados];
  return createHash("sha256").update(JSON.stringify(base)).digest("base64url").slice(0, 32);
}

/**
 * Tamanho em que a importação do Google CORTA o texto do evento (sincronizacao.ts
 * usa estes valores). Compromisso importado com o campo neste tamanho tem um
 * texto que o CRM Agro só conhece pela metade: mandá-lo de volta apagaria o resto
 * do evento na agenda da pessoa.
 */
export const LIMITE_TITULO_IMPORTADO = 300;
export const LIMITE_DESCRICAO_IMPORTADA = 5000;
export const LIMITE_LOCAL_IMPORTADO = 300;

/** Corpo do evento no Google a partir do compromisso (com ou sem os convidados). */
export function corpoDoEvento(a: Compromisso, tz: string, opts: { comConvidados: boolean }): EventoParaGoogle {
  // Texto do evento importado que a importação cortou: fica de fora (o PATCH
  // não mexe no campo omitido) — o CRM Agro não reescreve o que só viu pela metade.
  const cortado = (v: string | null, max: number) => a.origem === "google" && v !== null && v.length >= max;
  const fim = a.fim && a.fim > a.inicio ? a.fim : new Date(a.inicio.getTime() + UMA_HORA);
  const horario = a.diaInteiro
    ? (() => {
        // Dia inteiro: sempre no fuso do TIME, na ida e na volta (a data não anda).
        const ini = dataNoFuso(a.inicio, tz);
        let f = dataNoFuso(fim, tz);
        // No Google o fim do dia inteiro é EXCLUSIVO: mesmo dia → dia seguinte.
        if (f <= ini) f = dataNoFuso(new Date(a.inicio.getTime() + 24 * UMA_HORA), tz);
        return { start: { date: ini }, end: { date: f } };
      })()
    : { start: { dateTime: a.inicio.toISOString(), timeZone: tz }, end: { dateTime: fim.toISOString(), timeZone: tz } };
  return {
    ...(cortado(a.titulo, LIMITE_TITULO_IMPORTADO) ? {} : { summary: a.titulo }),
    // Vazio limpa lá (no PATCH, campo omitido fica como estava).
    ...(cortado(a.descricao, LIMITE_DESCRICAO_IMPORTADA) ? {} : { description: a.descricao ?? "" }),
    ...(cortado(a.local, LIMITE_LOCAL_IMPORTADO) ? {} : { location: a.local ?? "" }),
    ...horario,
    status: "confirmed",
    // Sem `responseStatus`: o Google mantém a resposta de quem já respondeu.
    ...(opts.comConvidados
      ? { attendees: a.convidados.map((c) => ({ email: c.email, ...(c.nome ? { displayName: c.nome } : {}) })) }
      : {}),
    extendedProperties: { private: { crmagroId: a.id } },
    // Reunião online sem link ainda: o Google cria o Meet junto (decisão 9).
    ...(a.tipo === "reuniao_online" && !a.reuniaoLink
      ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
}

/**
 * Convidados para o PATCH, mesclados com os de lá: quem continua mantém o que
 * o Google sabe dele (resposta, opcional, comentário), as salas (recursos) e o
 * próprio organizador ficam, e só entra/sai quem mudou na lista do CRM Agro. Se a
 * lista de e-mails não mudou, devolve undefined (o PATCH não mexe nos
 * convidados — um array enviado SUBSTITUI o de lá).
 */
export function convidadosParaPatch(lista: { email: string; nome: string | null }[], atuais: ConvidadoGoogle[] | undefined): ConvidadoGoogle[] | undefined {
  const deLa = atuais ?? [];
  const porEmail = new Map<string, ConvidadoGoogle>();
  for (const x of deLa) {
    const e = normalizarEmail(x.email);
    if (e && convidadoDeVerdade(x)) porEmail.set(e, x);
  }
  // Evento com mais convidados do que o CRM Agro guarda (importado com corte): não mexe na lista.
  if (porEmail.size > 100) return undefined;
  const nossos = new Set(lista.map((c) => c.email));
  const iguais = nossos.size === porEmail.size && [...nossos].every((e) => porEmail.has(e));
  if (iguais) return undefined;
  const fixos = deLa.filter((x) => !convidadoDeVerdade(x));
  return [...fixos, ...lista.map((c) => porEmail.get(c.email) ?? { email: c.email, ...(c.nome ? { displayName: c.nome } : {}) })];
}

/** Roda `fn` com um access token válido; um 401 força a renovação e tenta uma vez mais. */
export async function comAcesso<T>(c: ConexaoComToken, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await accessTokenDaConexao(c));
  } catch (e) {
    if (e instanceof GoogleApiErro && e.status === 401) {
      c.accessTokenExpiraEm = null;
      return fn(await accessTokenDaConexao(c));
    }
    throw e;
  }
}

async function conexaoDoResponsavel(responsavelId: string | null): Promise<Conexao | null> {
  if (!responsavelId) return null;
  const c = await db().oAuthConnection.findFirst({
    where: { userId: responsavelId, provider: PROVEDOR_GOOGLE, status: "connected" },
    select: SELECT_CONEXAO,
  });
  // Quem virou "só leitura", perdeu as telas ou saiu da lista de liberados (A2):
  // a agenda dele fica parada (o convite segue pelo .ics).
  return c && conexaoAtiva(c) ? c : null;
}

/** Pode ir para o Google pela PRIMEIRA vez? Não cancelado, não no passado, com a permissão da agenda. */
function elegivel(a: Compromisso, c: Conexao, agora: number): boolean {
  if (a.status === "cancelado") return false;
  if (!c.scopes.includes(ESCOPO_AGENDA)) return false;
  const fim = (a.fim ?? a.inicio).getTime();
  return fim >= agora - UMA_HORA;
}

/**
 * Os convidados vão NO EVENTO do Google desta conexão (e o Google os avisa)?
 * - já convidados: só pelo MESMO evento que os convidou (nunca um segundo convite
 *   por outra agenda ou depois do .ics);
 * - primeiro convite: só se quem fez a última alteração que o convidado vê é o
 *   DONO da agenda. Colega, gestor ou automação → .ics da caixa do time.
 */
function levaConvidados(a: Compromisso, c: { id: string; userId: string }): boolean {
  if (!a.convidados.length) return false;
  if (a.convitesEm) return a.convitesPorConexaoId === c.id;
  return a.alteradoPorId !== null && a.alteradoPorId === c.userId;
}

type Destino = { conexao: Conexao; vinculo: Vinculo | null } | { pendente: Vinculo } | "convite" | null;

async function destinoNoGoogle(a: Compromisso, agora: number): Promise<Destino> {
  // Integração desligada (variáveis fora do .env): ninguém tem agenda conectada
  // — o convite volta a sair pelo .ics e nada fica "pendente" para sempre.
  const ligada = googleAgendaConfigurada();
  for (const v of a.vinculos) {
    // Evento de fora em que a pessoa é só convidada: o Google é quem manda.
    if (v.origem === "convite") return "convite";
    if (!ligada) continue;
    // Evento que veio da agenda Google de alguém e mudou de responsável: o
    // evento continua sendo da conta Google daquela pessoa (não é cancelado),
    // e o CRM Agro para de escrever lá com o token dela. O vínculo vira SÓ
    // LEITURA (como o de convidado): as mudanças da agenda de origem seguem
    // chegando no mesmo compromisso, sem nascer um duplicado nem sair convite
    // em dobro. Nada sai agora.
    if (v.origem === "google" && v.connection.userId !== a.responsavelId) {
      await db().appointmentLink.update({ where: { id: v.id }, data: { origem: "convite", pendenteDesde: null, tentativas: 0 } });
      return "convite";
    }
    // O responsável mudou: o evento sai da agenda do antigo organizador (os
    // convidados recebem o cancelamento) e nasce na do novo, se conectada. O
    // cancelamento é DURÁVEL: o vínculo é aposentado (pendente) antes de
    // chamar o Google e só sai depois que o Google confirma — Google fora do
    // ar ou conta em "Reconectar" deixam o cancelamento na fila do worker (o
    // evento antigo, com os convidados, não fica vivo para sempre).
    if (v.origem === "crmagro" && v.connection.userId !== a.responsavelId) {
      const carregavaConvidados = a.convitesEm !== null && a.convitesPorConexaoId === v.connection.id;
      await db().appointmentLink.update({
        where: { id: v.id },
        data: { cancelarEm: new Date(), cancelarAvisando: carregavaConvidados, pendenteDesde: new Date(), tentativas: 0, ultimoErro: null },
      });
      if (conexaoAtiva(v.connection)) await cancelarVinculoAposentado(v.id);
      if (carregavaConvidados) {
        // Os convidados recebem o cancelamento daquele evento (agora ou quando
        // o worker conseguir): o convite novo é decidido de novo (pelo novo
        // dono, ou pelo .ics).
        await db().appointment.update({ where: { id: a.id }, data: { convitesEm: null, convitesPorConexaoId: null, convitesICalUID: null } });
        a.convitesEm = null;
        a.convitesPorConexaoId = null;
        a.convitesICalUID = null;
      }
      continue;
    }
    if (conexaoAtiva(v.connection)) return { conexao: v.connection, vinculo: v };
    // Conexão aguardando reconectar (ou parada, ou fora da lista de liberados):
    // guarda a mudança para depois.
    return { pendente: v };
  }
  if (!ligada) return null;
  const c = await conexaoDoResponsavel(a.responsavelId);
  return c && elegivel(a, c, agora) ? { conexao: c, vinculo: null } : null;
}

/**
 * Texto de um erro para log e para `ultimoErro`, SEM dado de cliente: dos erros
 * do Google (status HTTP + motivo curto) e da conexão a mensagem é segura; dos
 * demais (Prisma, rede) só o nome e o código — a mensagem de um erro de banco
 * pode trazer o argumento da consulta (título e nota do compromisso).
 */
export function erroSeguro(e: unknown): string {
  if (e instanceof GoogleApiErro || e instanceof GoogleAutorizacaoInvalida || e instanceof ConexaoGoogleInativa) return e.message.slice(0, 200);
  const nome = e instanceof Error ? e.name : "erro";
  const codigo = (e as { code?: unknown } | null)?.code;
  return typeof codigo === "string" ? `${nome} (${codigo.slice(0, 40)})` : nome;
}
const nomeDoErro = erroSeguro;

/**
 * Cancela, na agenda do antigo organizador, o evento de um vínculo aposentado
 * (troca de responsável) e só então apaga o vínculo (o `cancelarEvento` já
 * trata 404/410 como feito). Falhou: o vínculo fica pendente e o worker tenta
 * de novo (espera crescente); com a conta em "Reconectar", espera ela voltar.
 * Nunca lança. Roda no contexto do time.
 */
export async function cancelarVinculoAposentado(linkId: string): Promise<boolean> {
  const prisma = db();
  const v = await prisma.appointmentLink.findUnique({
    where: { id: linkId },
    select: { id: true, appointmentId: true, calendarId: true, externalEventId: true, cancelarEm: true, cancelarAvisando: true, connection: { select: SELECT_CONEXAO } },
  });
  if (!v?.cancelarEm) return false;
  try {
    await comAcesso(v.connection, (t) => cancelarEvento(t, v.calendarId, v.externalEventId, { sendUpdates: v.cancelarAvisando ? "all" : "none" }));
    // Só apaga se continua aposentado (o compromisso pode ter voltado para esta pessoa no meio).
    await prisma.appointmentLink.deleteMany({ where: { id: v.id, cancelarEm: { not: null } } });
    return true;
  } catch (e) {
    await prisma.appointmentLink
      .updateMany({ where: { id: v.id, cancelarEm: { not: null } }, data: { tentativas: { increment: 1 }, ultimoErro: nomeDoErro(e) } })
      .catch(() => {});
    logger.warn({ appointmentId: v.appointmentId, err: nomeDoErro(e) }, "[agenda-google] não cancelei o evento do responsável anterior (vai tentar de novo)");
    return false;
  }
}

/**
 * Leva o compromisso ao Google (ou manda o .ics). Nunca lança: o salvar do
 * compromisso já aconteceu. Roda no contexto do time (usuário ou sistema).
 */
export async function propagarCompromisso(appointmentId: string, m: Mudancas): Promise<void> {
  try {
    const a = (await db().appointment.findUnique({ where: { id: appointmentId }, select: SELECT_ENVIO })) as Compromisso | null;
    if (!a) return;
    const agora = Date.now();
    const destino = await destinoNoGoogle(a, agora);
    if (destino === "convite") return;
    if (destino && "pendente" in destino) {
      await db().appointmentLink.updateMany({ where: { id: destino.pendente.id, pendenteDesde: null }, data: { pendenteDesde: new Date() } });
      // Convidados que não vão pelo evento do Google: o .ics sai agora mesmo.
      if (!m.apenasGoogle && !levaConvidados(a, destino.pendente.connection)) await enviarIcs(a, m);
      return;
    }
    if (destino) {
      const leva = levaConvidados(a, destino.conexao);
      const r = await enviarAoGoogle(a, destino.conexao, destino.vinculo, m, leva);
      if (r === "sem_autorizacao_na_criacao" && leva && !m.apenasGoogle) {
        // O Google recusou a conta na hora de criar (7 dias do modo de teste,
        // acesso revogado): o convite não espera a pessoa reconectar — sai pelo
        // .ics agora, e o evento vai sem convidados quando ela reconectar.
        await db().appointmentLink.deleteMany({ where: { appointmentId: a.id, connectionId: destino.conexao.id, sincronizadoEm: null } });
        await enviarIcs(a, { ...m, criado: true });
      } else if (!leva && !m.apenasGoogle) {
        await enviarIcs(a, m);
      }
      return;
    }
    if (!m.apenasGoogle) await enviarIcs(a, m);
  } catch (e) {
    logger.warn({ appointmentId, err: nomeDoErro(e) }, "[agenda-google] falha ao propagar o compromisso");
  }
}

type ResultadoEnvio = "ok" | "nada" | "falhou" | "sem_autorizacao_na_criacao";

/** Sufixo sorteado para um id novo (base32hex: só hex). */
const sufixoNovo = () => randomBytes(4).toString("hex");

async function enviarAoGoogle(a: Compromisso, c: Conexao, v: Vinculo | null, m: Mudancas, leva: boolean): Promise<ResultadoEnvio> {
  const prisma = db();
  // Nada que o Google veja mudou e já está lá, em dia: nada a fazer.
  if (v && !v.pendenteDesde && !m.comuns && !m.status && !m.convidadosNovos.length) return "nada";
  if (a.status === "cancelado" && !v) return "nada";

  // Marca "pendente" ANTES de chamar o Google: se cair no meio, o worker refaz.
  const vinculo =
    v ??
    (await prisma.appointmentLink.upsert({
      where: { appointmentId_connectionId: { appointmentId: a.id, connectionId: c.id } },
      create: {
        appointmentId: a.id,
        connectionId: c.id,
        calendarId: "primary",
        externalEventId: idDoEventoGoogle(a.id, c.id),
        origem: "crmagro",
        pendenteDesde: new Date(),
      } as Prisma.AppointmentLinkUncheckedCreateInput,
      // Voltou para quem tinha um vínculo aposentado (cancelamento ainda na
      // fila): o evento de lá continua valendo — deixa de ser cancelado.
      update: { pendenteDesde: new Date(), cancelarEm: null, cancelarAvisando: false },
      select: { id: true, calendarId: true, externalEventId: true, origem: true, pendenteDesde: true, sincronizadoEm: true, tentativas: true, externalUpdatedAt: true },
    }));
  if (v && !v.pendenteDesde) await prisma.appointmentLink.update({ where: { id: v.id }, data: { pendenteDesde: new Date() } });
  const sendUpdates = leva ? ("all" as const) : ("none" as const);

  try {
    if (a.status === "cancelado") {
      // Decisão 6: cancelar no CRM Agro cancela no Google e AVISA os convidados
      // que estão no evento (os do .ics recebem o METHOD:CANCEL).
      await comAcesso(c, (t) => cancelarEvento(t, vinculo.calendarId, vinculo.externalEventId, { sendUpdates }));
      await prisma.appointmentLink.update({
        where: { id: vinculo.id },
        data: { pendenteDesde: null, tentativas: 0, ultimoErro: null, sincronizadoEm: new Date() },
      });
      return "ok";
    }
    const corpo = corpoDoEvento(a, await fusoDoTime(a.teamId), { comConvidados: leva });
    const opts = { sendUpdates, conferenceDataVersion: 1 as const };
    let ev: EventoGoogle;
    let eventId = vinculo.externalEventId;
    const atualizar = async () => {
      if (leva) {
        // PATCH substitui o array: mescla com o de lá (salas, opcionais e o organizador ficam).
        const atual = await comAcesso(c, (t) => obterEvento(t, vinculo.calendarId, eventId));
        corpo.attendees = convidadosParaPatch(a.convidados, atual.attendees);
        if (!corpo.attendees) delete corpo.attendees;
      }
      return comAcesso(c, (t) => atualizarEvento(t, vinculo.calendarId, eventId, corpo, opts));
    };
    // Nunca chegou lá (a criação falhou antes): cria com o mesmo id.
    if (!vinculo.sincronizadoEm) {
      try {
        ev = await comAcesso(c, (t) => inserirEvento(t, vinculo.calendarId, { ...corpo, id: eventId }, opts));
      } catch (e) {
        if (!(e instanceof GoogleApiErro && e.status === 409)) throw e;
        // Já existe um evento com este id nesta agenda. Só é "o nosso" (uma
        // criação que caiu no meio) se a pessoa é a ORGANIZADORA; senão é uma
        // cópia de convidado ou outra coisa: nasce com um id novo.
        const existente = await comAcesso(c, (t) => obterEvento(t, vinculo.calendarId, eventId)).catch(() => null);
        if (existente?.organizer?.self === true && existente.status !== "cancelled") {
          ev = await atualizar();
        } else {
          eventId = `${idDoEventoGoogle(a.id, c.id)}${sufixoNovo()}`;
          await prisma.appointmentLink.update({ where: { id: vinculo.id }, data: { externalEventId: eventId } });
          ev = await comAcesso(c, (t) => inserirEvento(t, vinculo.calendarId, { ...corpo, id: eventId }, opts));
        }
      }
    } else {
      ev = await atualizar();
    }
    const novoEm = ev.updated ? new Date(ev.updated) : null;
    // A sincronização pode ter gravado um retrato MAIS NOVO no meio do caminho:
    // o etag/`updated` só anda para a frente (senão a próxima rodada tomaria
    // uma mudança do Google como "eco").
    const maisNovo = !novoEm || !vinculo.externalUpdatedAt || novoEm >= vinculo.externalUpdatedAt;
    const hashNovo = hashDosCamposComuns(ev);
    await prisma.appointmentLink.update({
      where: { id: vinculo.id },
      data: {
        ...(maisNovo ? { etag: ev.etag ?? null, iCalUID: ev.iCalUID ?? null, externalUpdatedAt: novoEm, camposHash: hashNovo } : {}),
        pendenteDesde: null,
        tentativas: 0,
        ultimoErro: null,
        sincronizadoEm: new Date(),
      },
    });
    const noCompromisso: Prisma.AppointmentUncheckedUpdateInput = {};
    // O CRM Agro e o Google ficaram iguais: a base da comparação ao religar.
    if (maisNovo) noCompromisso.camposHashNoGoogle = hashNovo;
    // O canal do convite é este evento: guarda o UID dele (o .ics, se um dia
    // este Google sair de cena, atualiza a MESMA entrada no cliente de e-mail).
    if (leva && (!a.convitesEm || (ev.iCalUID && a.convitesICalUID !== ev.iCalUID))) {
      if (!a.convitesEm) Object.assign(noCompromisso, { convitesEm: new Date(), convitesPorConexaoId: c.id });
      noCompromisso.convitesICalUID = ev.iCalUID ?? null;
    }
    if (Object.keys(noCompromisso).length) await prisma.appointment.update({ where: { id: a.id }, data: noCompromisso });
    const link = linkDaReuniao(ev);
    if (link && link !== a.reuniaoLink) {
      await prisma.appointment.update({ where: { id: a.id }, data: { reuniaoLink: link, reuniaoProvedor: provedorDaReuniao(link) } });
    } else if (!link && corpo.conferenceData) {
      // O Meet é criado em segundo plano pelo Google: a sincronização busca o link daqui a pouco.
      await enfileirarSyncGoogle(c.id, { atrasoMs: 5_000 }).catch(() => {});
    }
    return "ok";
  } catch (e) {
    await prisma.appointmentLink
      .update({ where: { id: vinculo.id }, data: { tentativas: { increment: 1 }, ultimoErro: nomeDoErro(e) } })
      .catch(() => {});
    const semAutorizacao = e instanceof GoogleAutorizacaoInvalida || e instanceof ConexaoGoogleInativa;
    if (!semAutorizacao) {
      logger.warn({ appointmentId: a.id, connectionId: c.id, err: nomeDoErro(e) }, "[agenda-google] não levei o compromisso ao Google (vai tentar de novo)");
    }
    return semAutorizacao && !vinculo.sincronizadoEm ? "sem_autorizacao_na_criacao" : "falhou";
  }
}

// ---------------------------------------------------------------------------
// Convite .ics (sem agenda conectada, ou convite que não é do dono da agenda)
// ---------------------------------------------------------------------------

/** Escapa texto para um campo .ics (vírgula/ponto-e-vírgula/quebra). */
function icsEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
/** Parâmetro .ics (CN): sem aspas nem quebras. */
const icsParam = (s: string) => s.replace(/["\r\n;:,]/g, " ").trim();
/** Endereço num `mailto:` (já validado, mas nunca deixa quebrar a linha). */
const icsMail = (s: string) => s.replace(/[\r\n;:,"<>\s]/g, "");

/** Versão do convite: cresce a cada alteração (o cliente de e-mail troca o evento pelo novo). */
const sequencia = (d: Date) => Math.max(0, Math.floor((d.getTime() - Date.UTC(2020, 0, 1)) / 1000));

/**
 * UID do convite .ics. Convidados que foram convidados pelo evento de um
 * Google (que saiu de cena: desconectado, pessoa excluída, integração
 * desligada, troca de responsável sem como cancelar o evento antigo) recebem
 * a atualização com o UID DAQUELE evento — o cliente de e-mail atualiza/cancela
 * a mesma entrada em vez de criar uma segunda. (A SEQUENCE do .ics é sempre
 * maior que a do Google: a nossa versão vale.)
 */
export function uidDoConvite(a: Pick<Compromisso, "id" | "convitesICalUID">): string {
  const doGoogle = (a.convitesICalUID ?? "").replace(/[\r\n]/g, "").trim().slice(0, 300);
  return doGoogle || `${a.id}@crmagro`;
}

/** Monta o VCALENDAR do compromisso (REQUEST = convite/atualização; CANCEL = cancelamento). */
export function buildIcs(a: Compromisso, metodo: "REQUEST" | "CANCEL", tz: string): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const fim = a.fim && a.fim > a.inicio ? a.fim : new Date(a.inicio.getTime() + UMA_HORA);
  const dia = (d: Date) => dataNoFuso(d, tz).replace(/-/g, "");
  const horario = a.diaInteiro
    ? [`DTSTART;VALUE=DATE:${dia(a.inicio)}`, `DTEND;VALUE=DATE:${dia(new Date(Math.max(fim.getTime(), a.inicio.getTime() + 24 * UMA_HORA)))}`]
    : [`DTSTART:${fmt(a.inicio)}`, `DTEND:${fmt(fim)}`];
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CRM Agro//Agenda//PT-BR",
    `METHOD:${metodo}`,
    "BEGIN:VEVENT",
    `UID:${icsEsc(uidDoConvite(a))}`,
    `SEQUENCE:${sequencia(a.camposComunsEm)}`,
    `DTSTAMP:${fmt(new Date())}`,
    ...horario,
    `SUMMARY:${icsEsc(a.titulo)}`,
    a.descricao ? `DESCRIPTION:${icsEsc(a.descricao)}` : "",
    a.local ? `LOCATION:${icsEsc(a.local)}` : "",
    a.reuniaoLink ? `URL:${icsMail(a.reuniaoLink)}` : "",
    metodo === "CANCEL" ? "STATUS:CANCELLED" : "",
    ...a.convidados.map((c) => `ATTENDEE;${c.nome ? `CN="${icsParam(c.nome)}";` : ""}RSVP=TRUE:mailto:${icsMail(c.email)}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

/**
 * O Google mudou (horário, título, local, cancelou/restaurou) um compromisso
 * cujos convidados NÃO estão naquele evento (foram convidados pelo .ics do
 * time ou por outra agenda): eles só ficam sabendo pelo .ics — REQUEST com o
 * mesmo UID e SEQUENCE nova, ou CANCEL. Nunca lança.
 */
export async function avisarConvidadosPeloIcs(appointmentId: string, m: Pick<Mudancas, "status">): Promise<void> {
  try {
    const a = (await db().appointment.findUnique({ where: { id: appointmentId }, select: SELECT_ENVIO })) as Compromisso | null;
    if (a?.convitesEm) await enviarIcs(a, { comuns: true, convidadosNovos: [], ...m });
  } catch (e) {
    logger.warn({ appointmentId, err: nomeDoErro(e) }, "[agenda-google] falha ao avisar os convidados pelo .ics");
  }
}

/**
 * Retrato do compromisso como o CRM Agro o mandaria ao evento `ev` desta conexão:
 * a impressão digital dos campos comuns (com os convidados que vão no evento;
 * os que não vão ficam como estão lá) e se está cancelado. Serve ao religar
 * um evento depois de reconectar a agenda: comparado com a base
 * (`camposHashNoGoogle`), diz se o CRM Agro mudou enquanto ela estava fora.
 */
export async function retratoParaOGoogle(
  appointmentId: string,
  c: { id: string; userId: string },
  ev: EventoGoogle,
  tz: string,
): Promise<{ hash: string; cancelado: boolean } | null> {
  const a = (await db().appointment.findUnique({ where: { id: appointmentId }, select: SELECT_ENVIO })) as Compromisso | null;
  if (!a) return null;
  const leva = levaConvidados(a, c);
  const corpo = corpoDoEvento(a, tz, { comConvidados: leva });
  const lista = leva ? (corpo.attendees ?? []) : (ev.attendees ?? []);
  return { hash: hashDosCamposComuns({ ...corpo, id: ev.id, attendees: lista }), cancelado: a.status === "cancelado" };
}

/** Convite .ics por e-mail aos convidados (best-effort — sem caixa conectada, não sai). */
async function enviarIcs(a: Compromisso, m: Mudancas): Promise<void> {
  if (!a.convidados.length) return;
  const cancelar = m.status === "cancelado" || (a.status === "cancelado" && m.comuns);
  if (a.status === "cancelado" && !cancelar) return;
  // Primeiro convite deste compromisso: vai para todos (ninguém recebeu nada ainda).
  const primeiro = !a.convitesEm && !cancelar;
  const todos = primeiro || cancelar || m.criado || m.status === "reaberto" || m.comuns;
  const para = todos ? a.convidados.map((c) => c.email) : m.convidadosNovos;
  if (!para.length) return;
  const tz = await fusoDoTime(a.teamId);
  const quando = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: a.diaInteiro ? undefined : "short", timeZone: tz }).format(a.inicio);
  const ics = buildIcs(a, cancelar ? "CANCEL" : "REQUEST", tz);
  const texto = cancelar
    ? `O compromisso "${a.titulo}" de ${quando} foi cancelado.`
    : `Você foi convidado para "${a.titulo}" em ${quando}.${a.local ? `\nLocal: ${a.local}` : ""}${a.reuniaoLink ? `\nLink da reunião: ${a.reuniaoLink}` : ""}${a.descricao ? `\n\n${a.descricao}` : ""}`;
  for (const to of para) {
    try {
      await sendCalendarInvite({ to, subject: `${cancelar ? "Cancelado" : "Convite"}: ${a.titulo}`, text: texto, ics });
    } catch {
      /* sem conta de e-mail conectada ou falha de envio: ignora (como antes) */
    }
  }
  // O canal do convite deste compromisso passa a ser o e-mail: o Google nunca
  // manda um segundo convite a quem já recebeu este.
  if (primeiro) {
    await db().appointment.update({ where: { id: a.id }, data: { convitesEm: new Date(), convitesPorConexaoId: null } });
    a.convitesEm = new Date();
  }
}

// ---------------------------------------------------------------------------
// Rodada do worker: o que ficou para trás
// ---------------------------------------------------------------------------

/** Espera antes da próxima tentativa: 1, 2, 4… até 60 min. */
const esperaDaTentativa = (n: number) => Math.min(60, 2 ** Math.max(0, n - 1)) * 60_000;
const MAX_TENTATIVAS = 12;

/**
 * A conexão ainda vale para escrever na agenda? A pessoa ativa, com papel de
 * membro para cima e a tela Agenda ou Integrações. Quem virou "só leitura" ou
 * perdeu as duas telas fica com a sincronização PARADA (e ainda pode
 * desconectar pelo menu da conta).
 */
export function conexaoEmUso(u: { role: string; modulos: string[]; desativadoEm: Date | null }): boolean {
  if (u.desativadoEm || u.role === "viewer") return false;
  return temModulo(u.role, u.modulos, "agenda") || temModulo(u.role, u.modulos, "integracoes");
}

/**
 * A conexão pode falar com o Google agora? Conectada, com a pessoa em uso
 * (`conexaoEmUso`) e LIBERADA (`GOOGLE_AGENDA_LIBERADOS`, A2): quem saiu da
 * lista fica com a agenda parada — nenhum evento é criado, alterado nem
 * cancelado no Google com o token dela, e nada é apagado.
 */
export function conexaoAtiva(c: { status: string; teamId: string; user: { email: string; role: string; modulos: string[]; desativadoEm: Date | null } }): boolean {
  return c.status === "connected" && conexaoEmUso(c.user) && agendaGoogleLiberadaPara({ teamId: c.teamId, email: c.user.email });
}

/**
 * (1) Vínculos pendentes (Google fora, conexão que voltou) e (2) compromissos
 * futuros de quem conectou a agenda e que ainda não foram para lá (criados
 * pela automação — retorno de caixa postal, follow-up da campanha —, antes da
 * conexão, ou recebidos de quem saiu do time). Os convidados só vão no evento
 * se o dono da agenda os convidou (`levaConvidados`): quem já recebeu o .ics
 * ou o convite de outra agenda não recebe um segundo. Cruza times: lê pelo
 * basePrisma e escreve no contexto do time de cada linha. `prazo`: a rodada
 * para ali (a manutenção roda a cada minuto e não pode empilhar).
 */
export async function enviarPendentesAoGoogle(agora = new Date(), prazo = Number.POSITIVE_INFINITY): Promise<{ enviados: number }> {
  let enviados = 0;
  if (!googleAgendaConfigurada()) return { enviados };
  const pendentes = await basePrisma.appointmentLink.findMany({
    where: {
      pendenteDesde: { lte: new Date(agora.getTime() - 30_000) },
      tentativas: { lt: MAX_TENTATIVAS },
      origem: { in: ["crmagro", "google"] },
      // A2: só as conexões de quem está liberado (as paradas não ocupam as 100 vagas).
      connection: { status: "connected", AND: [filtroDeConexoesLiberadas()] },
    },
    orderBy: { pendenteDesde: "asc" },
    take: 100,
    select: {
      id: true,
      appointmentId: true,
      teamId: true,
      tentativas: true,
      updatedAt: true,
      cancelarEm: true,
      connection: { select: { user: { select: { email: true, role: true, modulos: true, desativadoEm: true } } } },
    },
  });
  for (const p of pendentes) {
    if (Date.now() > prazo) return { enviados };
    if (p.tentativas > 0 && p.updatedAt.getTime() + esperaDaTentativa(p.tentativas) > agora.getTime()) continue;
    if (!conexaoAtiva({ status: "connected", teamId: p.teamId, user: p.connection.user })) continue;
    // Reserva o vínculo (CAS no `updatedAt`): duas rodadas nunca levam o mesmo.
    const { count } = await runAsSystem(p.teamId, () =>
      db().appointmentLink.updateMany({ where: { id: p.id, updatedAt: p.updatedAt }, data: { tentativas: p.tentativas } }),
    );
    if (count !== 1) continue;
    // Vínculo aposentado (troca de responsável): só o cancelamento na agenda antiga.
    if (p.cancelarEm) await runAsSystem(p.teamId, () => cancelarVinculoAposentado(p.id));
    else await runAsSystem(p.teamId, () => propagarCompromisso(p.appointmentId, { comuns: true, convidadosNovos: [], apenasGoogle: true }));
    enviados++;
  }

  const conexoes = await basePrisma.oAuthConnection.findMany({
    where: {
      provider: PROVEDOR_GOOGLE,
      status: "connected",
      user: { desativadoEm: null, role: { not: "viewer" } },
      AND: [filtroDeConexoesLiberadas()],
      // Só depois da 1ª sincronização completa: o que já está na agenda (ex.: a
      // pessoa reconectou) é religado por ela, sem nascer um evento em dobro.
      calendarios: { some: { syncToken: { not: null } } },
    },
    select: { teamId: true, userId: true, user: { select: { email: true, role: true, modulos: true, desativadoEm: true } } },
    take: 500,
  });
  for (const c of conexoes) {
    if (Date.now() > prazo) return { enviados };
    if (!conexaoAtiva({ status: "connected", teamId: c.teamId, user: c.user })) continue;
    const faltam = await basePrisma.appointment.findMany({
      where: {
        teamId: c.teamId,
        responsavelId: c.userId,
        status: "pendente",
        // Só os criados no CRM Agro: o que veio do Google e perdeu o vínculo não
        // volta para lá sozinho (vai no próximo salvar da pessoa).
        origem: "crmagro",
        inicio: { gte: new Date(agora.getTime() - UMA_HORA), lte: new Date(agora.getTime() + 180 * 24 * UMA_HORA) },
        // O vínculo aposentado (cancelamento na agenda do antigo dono) não conta.
        vinculos: { none: { cancelarEm: null } },
      },
      orderBy: { inicio: "asc" },
      take: 20,
      select: { id: true },
    });
    for (const a of faltam) {
      await runAsSystem(c.teamId, () => propagarCompromisso(a.id, { criado: true, comuns: true, convidadosNovos: [], apenasGoogle: true }));
      enviados++;
    }
  }
  return { enviados };
}
