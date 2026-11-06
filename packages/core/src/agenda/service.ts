import type { Prisma, AppointmentType, AppointmentStatus } from "@prisma/client";
import { z } from "zod";
import { db, tenantData } from "@crmagro/db";
import { assertOwned, assertOwnedIfPresent, EdicaoNaoPermitida, OwnedNotFound } from "../tenancy/assert-owned";
import { ForbiddenError, getActor, requireCan } from "../auth/authz";
import { escopoDoAtor, type UsoDoEscopo } from "../tenancy/escopo";
import { escopoDoContato } from "../contacts/escopo";
import { MAX_CONVIDADOS, normalizarConvidados, substituirConvidados, type ConvidadoDTO, type ConvidadoInput } from "./convidados";
import { googleAgendaConfigurada } from "./google/conexao";
import { propagarCompromisso } from "./google/envio";

/**
 * Colega/gestor tentou incluir (ou tirar) convidados num evento que o
 * responsável já mandou pelo Google Agenda DELE: o convite sairia da conta
 * Google de outra pessoa. Só o responsável mexe nos convidados ali (revisão do
 * #169).
 */
export class ConviteSoPeloResponsavel extends ForbiddenError {
  constructor() {
    super("Só o responsável muda os convidados deste compromisso: o convite sai pelo Google Agenda dele.");
    this.name = "ConviteSoPeloResponsavel";
  }
}

/**
 * Colega/gestor ("Ver e editar de todos") tentou mudar o CONTEÚDO do convite
 * (título, descrição, local, reunião online) ou reabrir um compromisso cujo
 * convite saiu pelo Google Agenda do responsável: a atualização iria aos
 * clientes pela conta Google dele, com o texto de outra pessoa (3ª revisão do
 * #169). Quem não é o responsável só REMARCA ou CANCELA ali.
 */
export class AlteracaoSoPeloResponsavel extends ForbiddenError {
  constructor(acao: "conteudo" | "reabrir" = "conteudo") {
    super(
      acao === "reabrir"
        ? "Só o responsável reabre este compromisso: o convite sai de novo pelo Google Agenda dele."
        : "Só o responsável muda o título, a nota, o local e a reunião online deste compromisso: o convite saiu pelo Google Agenda dele. Você pode remarcar ou cancelar.",
    );
    this.name = "AlteracaoSoPeloResponsavel";
  }
}

/**
 * A dona tentou passar para outra pessoa (ou para "do time") um compromisso que
 * veio da Agenda Google dela e que ela ainda não confirmou: a outra pessoa (ou
 * o lembrete, que vai aos administradores quando não há responsável) leria a
 * agenda pessoal dela. Antes, "Manter no CRM Agro" (A1, 3ª conferência do #169).
 */
export class ConfirmarAntesDeTransferir extends ForbiddenError {
  constructor() {
    super("Este compromisso veio da sua Agenda Google e só você o vê. Use \"Manter no CRM Agro\" antes de passá-lo para outra pessoa.");
    this.name = "ConfirmarAntesDeTransferir";
  }
}

/** Mais convidados do que o CRM Agro convida de uma vez. */
export class LimiteDeConvidados extends Error {
  constructor() {
    super(`No máximo ${MAX_CONVIDADOS} convidados por compromisso.`);
    this.name = "LimiteDeConvidados";
  }
}

/** Maior antecedência do lembrete: 1 dia (o job busca as próximas 24 h). */
export const LEMBRETE_MAX_MIN = 24 * 60;

export type { ConvidadoDTO, ConvidadoInput } from "./convidados";

export type AppointmentDTO = {
  id: string;
  titulo: string;
  descricao: string | null;
  tipo: AppointmentType;
  inicio: string;
  fim: string | null;
  status: AppointmentStatus;
  contactId: string | null;
  contactNome: string | null;
  /** Convidados (decisão 8): contatos, colegas do time e e-mails avulsos. */
  convidados: ConvidadoDTO[];
  /** Visita (§E): endereço livre e a coordenada herdada do contato. */
  local: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Minutos de antecedência do lembrete; null = sem lembrete. */
  lembreteMin: number | null;
  /** Quando o lembrete dispara (ISO); null = sem lembrete. */
  lembreteEm: string | null;
  /** Dono do compromisso; null = do time (criado pela automação). */
  responsavelId: string | null;
  responsavelNome: string | null;
  /** "crmagro" (criado aqui) ou "google" (veio da agenda da pessoa, com contato). */
  origem: string;
  diaInteiro: boolean;
  /** Link da videochamada, quando é reunião online (só https). */
  reuniaoLink: string | null;
  /** "meet" (Google Meet) ou "outro" (a tela mostra o endereço). */
  reuniaoProvedor: string | null;
  /**
   * Estado no Google Agenda: null = não está lá; "pendente" = a última
   * alteração ainda não chegou; "reconectar" = parada até a pessoa reconectar
   * a agenda.
   */
  google: "sincronizado" | "pendente" | "reconectar" | null;
  /**
   * Papel no Google: "organizador" (o evento é do responsável — o CRM Agro
   * escreve lá) ou "convidado" (evento de OUTRA pessoa: horário e convidados
   * mudam só lá, e cancelar aqui não avisa ninguém).
   */
  googlePapel: "organizador" | "convidado" | null;
  /**
   * Os convidados foram convidados pelo Google Agenda do responsável: quem não
   * é o responsável só remarca ou cancela (o resto da mudança iria aos
   * clientes pela conta Google dele).
   */
  conviteNoGoogle: boolean;
  /**
   * Veio da Agenda Google do responsável e ele ainda não confirmou que é de
   * trabalho: só ele vê ("Manter no CRM Agro" ou "Tirar do CRM Agro").
   */
  privado: boolean;
};

export type CreateAppointmentInput = {
  titulo: string;
  descricao?: string;
  tipo?: AppointmentType;
  inicio: string; // ISO
  fim?: string | null;
  contactId?: string | null;
  /** Convidados (vários). Ausente = não mexe (na edição). */
  convidados?: ConvidadoInput[];
  /** Legado (um convidado só): vira `convidados` quando a lista não vem. */
  convidadoEmail?: string | null;
  local?: string | null;
  /** Ausente = 30 min (padrão); null = sem lembrete; 0 a 1440. */
  lembreteMin?: number | null;
  /** Ausente = quem cria. Tem de ser usuário do time. */
  responsavelId?: string | null;
};

/** Campos novos da Agenda (§E) validados na borda; os antigos seguem como eram. */
const camposAgendaSchema = z.object({
  local: z.string().trim().max(300).nullish(),
  lembreteMin: z.number().int().min(0).max(LEMBRETE_MAX_MIN).nullish(),
  responsavelId: z.string().min(1).max(64).nullish(),
});

const SELECT = {
  id: true,
  titulo: true,
  descricao: true,
  tipo: true,
  inicio: true,
  fim: true,
  status: true,
  contactId: true,
  local: true,
  latitude: true,
  longitude: true,
  lembreteMin: true,
  lembreteEm: true,
  responsavelId: true,
  origem: true,
  diaInteiro: true,
  reuniaoLink: true,
  reuniaoProvedor: true,
  convitesPorConexaoId: true,
  privadoAteConfirmar: true,
  contact: { select: { nome: true } },
  responsavel: { select: { name: true } },
  convidados: {
    select: { email: true, nome: true, userId: true, contactId: true, resposta: true },
    orderBy: { createdAt: "asc" },
  },
  // O vínculo aposentado (cancelamento na agenda do antigo dono) não é o estado deste compromisso.
  vinculos: {
    where: { cancelarEm: null },
    select: { pendenteDesde: true, origem: true, connectionId: true, connection: { select: { status: true } } },
  },
} satisfies Prisma.AppointmentSelect;

type Row = Prisma.AppointmentGetPayload<{ select: typeof SELECT }>;

/**
 * O convite saiu por um Google (o canal é uma conexão) — esteja o vínculo vivo
 * ou não: desconectar e reconectar a mesma conta religa o evento que convidou,
 * então a regra olha o CANAL, não o vínculo. A cópia de convidado (evento de
 * outra pessoa, só leitura) não conta: nada sai por ela.
 */
function conviteNoGoogle(a: { convitesPorConexaoId: string | null; vinculos: { connectionId: string; origem: string }[] }): boolean {
  if (!a.convitesPorConexaoId) return false;
  return !a.vinculos.some((v) => v.connectionId === a.convitesPorConexaoId && v.origem === "convite");
}

function estadoNoGoogle(r: Row): Pick<AppointmentDTO, "google" | "googlePapel"> {
  if (!r.vinculos.length || !googleAgendaConfigurada()) return { google: null, googlePapel: null };
  const pendente = r.vinculos.find((v) => v.pendenteDesde);
  return {
    google: pendente ? (pendente.connection.status === "connected" ? "pendente" : "reconectar") : "sincronizado",
    googlePapel: r.vinculos.some((v) => v.origem !== "convite") ? "organizador" : "convidado",
  };
}

/**
 * Contato que quem lê NÃO vê (revisão do #169): colega que enxerga o
 * compromisso só por ser CONVIDADO não descobre por ele se um e-mail é
 * contato do time nem o nome — o contato sai do DTO (o do compromisso e o de
 * cada convidado), a menos que esteja no escopo de Contatos dele. Quem é o
 * responsável, o sistema e quem vê a Agenda de todos seguem como antes.
 */
async function contatosOcultos(rows: Row[]): Promise<Set<string>> {
  const ator = getActor();
  if (!ator || ator.system || escopoDoAtor("agenda").tudo) return new Set();
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.responsavelId === ator.userId) continue;
    if (r.contactId) ids.add(r.contactId);
    for (const c of r.convidados) if (c.contactId) ids.add(c.contactId);
  }
  if (!ids.size) return new Set();
  const visiveis = await db().contact.findMany({ where: { AND: [{ id: { in: [...ids] } }, escopoDoContato()] }, select: { id: true } });
  const vistos = new Set(visiveis.map((c) => c.id));
  return new Set([...ids].filter((id) => !vistos.has(id)));
}

async function toDTOs(rows: Row[]): Promise<AppointmentDTO[]> {
  const ocultos = await contatosOcultos(rows);
  const ator = getActor();
  // Quem é o responsável (e o sistema, e quem vê a Agenda de todos) não tem nada
  // mascarado — a mesma regra de `contatosOcultos`. O conjunto vale para a lista
  // toda: sem isto, o contato oculto numa linha mascararia a linha em que a
  // pessoa é a responsável.
  return rows.map((r) => toDTO(r, ator && r.responsavelId === ator.userId ? new Set() : ocultos));
}

function toDTO(r: Row, ocultos: Set<string>): AppointmentDTO {
  const contatoVisivel = Boolean(r.contactId && !ocultos.has(r.contactId));
  return {
    id: r.id,
    titulo: r.titulo,
    descricao: r.descricao,
    tipo: r.tipo,
    inicio: r.inicio.toISOString(),
    fim: r.fim ? r.fim.toISOString() : null,
    status: r.status,
    contactId: contatoVisivel ? r.contactId : null,
    contactNome: contatoVisivel ? (r.contact?.nome ?? null) : null,
    convidados: r.convidados.map((c) => {
      // O nome do convidado-contato vem do cadastro do CRM (`normalizarConvidados`):
      // quem não vê o contato fica só com o e-mail do convite.
      const oculto = Boolean(c.contactId && ocultos.has(c.contactId));
      return { email: c.email, nome: oculto ? null : c.nome, userId: c.userId, contactId: oculto ? null : c.contactId, resposta: c.resposta };
    }),
    local: r.local,
    // A coordenada da visita é do endereço do contato (geocodificação do Mapa):
    // sem ver o contato, não vê onde ele fica.
    latitude: contatoVisivel || !r.contactId ? r.latitude : null,
    longitude: contatoVisivel || !r.contactId ? r.longitude : null,
    lembreteMin: r.lembreteMin,
    lembreteEm: r.lembreteEm ? r.lembreteEm.toISOString() : null,
    responsavelId: r.responsavelId,
    responsavelNome: r.responsavel?.name ?? null,
    origem: r.origem,
    diaInteiro: r.diaInteiro,
    reuniaoLink: r.reuniaoLink,
    reuniaoProvedor: r.reuniaoLink ? (r.reuniaoProvedor ?? "outro") : null,
    ...estadoNoGoogle(r),
    conviteNoGoogle: conviteNoGoogle(r),
    privado: r.privadoAteConfirmar,
  };
}

async function usuarioDoTimeOuNull(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  return (await db().user.count({ where: { id: userId } })) === 1 ? userId : null;
}

/** Coordenada da visita: a do contato (geocodificação do Mapa), ou nenhuma. */
async function coordenadaDoContato(
  tipo: AppointmentType,
  contactId: string | null,
): Promise<{ latitude: number | null; longitude: number | null }> {
  if (tipo !== "visita" || !contactId) return { latitude: null, longitude: null };
  const c = await db().contact.findUnique({ where: { id: contactId }, select: { latitude: true, longitude: true } });
  return { latitude: c?.latitude ?? null, longitude: c?.longitude ?? null };
}

/** Lista de convidados do input (a nova ou o legado de um só); undefined = não mexe. */
function convidadosDoInput(input: Partial<CreateAppointmentInput>): ConvidadoInput[] | undefined {
  if (input.convidados !== undefined) return input.convidados ?? [];
  if (input.convidadoEmail !== undefined) {
    const e = input.convidadoEmail?.trim();
    return e ? [{ email: e }] : [];
  }
  return undefined;
}

async function lerDTO(id: string): Promise<AppointmentDTO> {
  const row = await db().appointment.findUnique({ where: { id }, select: SELECT });
  if (!row) throw new OwnedNotFound("appointment", [id]);
  return (await toDTOs([row]))[0]!;
}

/** Quem fez a alteração que o convidado vê: a pessoa (o sistema/automação = null). */
const autorDaAlteracao = (ator: { system?: boolean; userId: string }) => (ator.system ? null : ator.userId);

/**
 * Cria um compromisso (opcionalmente ligado a um contato). Depois de gravar,
 * leva ao Google Agenda do responsável (com os convidados e o Meet) ou, sem
 * agenda conectada, manda o convite .ics por e-mail.
 */
export async function createAppointment(input: CreateAppointmentInput): Promise<AppointmentDTO> {
  const ator = requireCan("agenda.write");
  const titulo = input.titulo.trim();
  if (!titulo) throw new Error("título obrigatório");
  const inicio = new Date(input.inicio);
  if (isNaN(inicio.getTime())) throw new Error("data inválida");
  const fim = input.fim ? new Date(input.fim) : null;
  if (fim && isNaN(fim.getTime())) throw new Error("data de fim inválida");
  const extra = camposAgendaSchema.parse(input);
  // S1: contato e responsável opcionais vindos do cliente — se vieram, têm de ser do time.
  await assertOwnedIfPresent("contact", input.contactId);
  if (extra.responsavelId) await assertOwned("user", extra.responsavelId);
  const convidados = await normalizarConvidados(convidadosDoInput(input) ?? []);
  if (convidados.length > MAX_CONVIDADOS) throw new LimiteDeConvidados();
  // Sem responsável informado: quem cria. A automação (e uma sessão cujo
  // usuário já não existe no time) cria "do time", sem dono. `null` também
  // vale como "não informado": a tela manda `null` quando o seletor está em
  // "Eu" (não há opção "do time"), e um compromisso sem dono nunca iria ao
  // Google Agenda de ninguém (A1, 3ª conferência do #169).
  const responsavelId = extra.responsavelId ? extra.responsavelId : await usuarioDoTimeOuNull(ator.system ? null : ator.userId);
  const tipo = input.tipo ?? "tarefa";
  const contactId = input.contactId ?? null;
  const row = await db().appointment.create({
    data: tenantData<Prisma.AppointmentUncheckedCreateInput>({
      titulo,
      descricao: input.descricao?.trim() || null,
      tipo,
      inicio,
      fim,
      contactId,
      local: extra.local || null,
      ...(extra.lembreteMin !== undefined ? { lembreteMin: extra.lembreteMin } : {}),
      responsavelId,
      camposComunsEm: new Date(),
      // Quem criou: só o próprio responsável convida pelo Google Agenda dele.
      alteradoPorId: autorDaAlteracao(ator),
      ...(await coordenadaDoContato(tipo, contactId)),
    }),
    select: { id: true, teamId: true },
  });
  const conv = convidados.length ? await substituirConvidados(row.id, row.teamId, convidados) : { novos: [] as string[] };
  await propagarCompromisso(row.id, { criado: true, comuns: true, convidadosNovos: conv.novos });
  return lerDTO(row.id);
}

/**
 * Escopo por pessoa da Agenda (auditoria de isolamento 09/2026). Antes, o
 * calendário, o Painel e as Atividades listavam os compromissos do TIME
 * inteiro para qualquer membro — título, contato, local e coordenada da visita
 * do colega — e qualquer membro remarcava, concluía ou apagava o compromisso
 * de outro. Regra (a mesma do alerta `listDueAppointments`, que já filtrava):
 * - master, administrador, "ver tudo" na Agenda (é por tela) e o sistema: todos;
 * - membro/só leitura: os DELE (responsável) + os "do time" (sem responsável,
 *   criados pela automação) — estes só se não têm contato ou se o contato é do
 *   escopo dele (o compromisso do time não revela o contato do colega);
 * - LEITURA também dos compromissos em que a pessoa é CONVIDADA (decisão 8:
 *   colegas convidados veem a reunião na Agenda deles; alterar, só o responsável).
 */
function escopoCompromisso(uso: UsoDoEscopo = {}): Prisma.AppointmentWhereInput {
  const e = escopoDoAtor("agenda", uso);
  // Veio da Agenda Google e a dona não confirmou que é de trabalho: só ELA
  // (3ª revisão do #169) — nem o gestor, nem o master, nem o "ver como" (que
  // usa o id dela). O gatilho da importação depende do dono do contato, que
  // outras pessoas decidem (transferir, atribuir, captação).
  const ator = getActor();
  const privado: Prisma.AppointmentWhereInput =
    ator && !ator.system ? { OR: [{ privadoAteConfirmar: false }, { responsavelId: ator.userId }] } : {};
  if (e.tudo) return privado;
  if (e.semAtor) return { responsavelId: e.userId };
  return {
    AND: [
      privado,
      {
        OR: [
          { responsavelId: e.userId },
          { responsavelId: null, contactId: null },
          { responsavelId: null, contact: escopoDoContato(uso) },
          ...(uso.escrita ? [] : [{ convidados: { some: { userId: e.userId } } }]),
        ],
      },
    ],
  };
}

/**
 * O compromisso existe no time E a pessoa pode ALTERÁ-LO (escopo de escrita:
 * "Ver e editar de todos" na Agenda). Vê mas não edita → `EdicaoNaoPermitida`;
 * não vê → "não encontrado".
 */
async function exigirCompromissoNoEscopo(id: string): Promise<void> {
  const prisma = db();
  if ((await prisma.appointment.count({ where: { AND: [{ id }, escopoCompromisso({ escrita: true })] } })) === 1) return;
  if ((await prisma.appointment.count({ where: { AND: [{ id }, escopoCompromisso()] } })) === 1) throw new EdicaoNaoPermitida();
  throw new OwnedNotFound("appointment", [id]);
}

/** Lista compromissos num intervalo [from, to) — para o calendário. */
export async function listAppointments(range: { from: string; to: string }): Promise<AppointmentDTO[]> {
  const rows = await db().appointment.findMany({
    where: { AND: [{ inicio: { gte: new Date(range.from), lt: new Date(range.to) } }, escopoCompromisso()] },
    orderBy: { inicio: "asc" },
    select: SELECT,
  });
  return toDTOs(rows);
}

/** Próximos compromissos pendentes (para atalhos/dashboard). */
export async function listUpcomingAppointments(limit = 10): Promise<AppointmentDTO[]> {
  const rows = await db().appointment.findMany({
    where: { AND: [{ status: "pendente", inicio: { gte: new Date() } }, escopoCompromisso()] },
    orderBy: { inicio: "asc" },
    take: limit,
    select: SELECT,
  });
  return toDTOs(rows);
}

/** Mesmo instante até o segundo (o trigger do lembrete zera a trava a cada mudança de `inicio`). */
const mesmoInstante = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000));

export async function updateAppointment(
  id: string,
  input: Partial<CreateAppointmentInput>,
): Promise<AppointmentDTO> {
  const ator = requireCan("agenda.write");
  const extra = camposAgendaSchema.parse(input);
  // Escopo por pessoa (auditoria 09/2026): só remarca o compromisso que pode alterar.
  await exigirCompromissoNoEscopo(id);
  const antes = await db().appointment.findUnique({
    where: { id },
    select: {
      teamId: true,
      titulo: true,
      descricao: true,
      tipo: true,
      inicio: true,
      fim: true,
      local: true,
      contactId: true,
      responsavelId: true,
      privadoAteConfirmar: true,
      convitesPorConexaoId: true,
      convidados: { select: { email: true } },
      vinculos: { where: { cancelarEm: null }, select: { connectionId: true, origem: true } },
    },
  });
  if (!antes) throw new OwnedNotFound("appointment", [id]);
  const listaConvidados = convidadosDoInput(input);
  const convidados = listaConvidados !== undefined ? await normalizarConvidados(listaConvidados) : undefined;
  const responsavelMudou = extra.responsavelId !== undefined && extra.responsavelId !== antes.responsavelId;
  // O que veio da Agenda Google dela e não foi confirmado é só da dona: passar
  // para outra pessoa, ou para "do time", o mostraria (a outra pessoa, ou o
  // lembrete dos administradores). Confirmar antes ("Manter no CRM Agro").
  if (responsavelMudou && antes.privadoAteConfirmar) throw new ConfirmarAntesDeTransferir();
  // O convite saiu pelo Google Agenda do responsável e quem altera é OUTRA
  // pessoa (ou a automação), sem trocar o responsável: o que ela mudar vai aos
  // clientes pela conta Google dele (sendUpdates=all). Só remarcar e cancelar
  // (decisão consciente: os convidados precisam saber do horário novo); o
  // conteúdo do convite, os convidados e o reabrir são só do responsável. A
  // regra olha o CANAL (`convitesPorConexaoId`), não o vínculo: com a agenda
  // desconectada, a próxima reconexão religa o evento e levaria a mudança.
  // Trocar o responsável cancela o evento dele e decide o convite de novo.
  const outraPessoaNoGoogleDoResponsavel =
    !responsavelMudou && conviteNoGoogle(antes) && (ator.system || ator.userId !== antes.responsavelId);
  if (convidados !== undefined) {
    const jaEram = new Set(antes.convidados.map((c) => c.email));
    const entram = convidados.filter((c) => !jaEram.has(c.email));
    const ficam = new Set(convidados.map((c) => c.email));
    const saem = antes.convidados.filter((c) => !ficam.has(c.email));
    // O evento importado do Google pode ter até 100: salva igual, mas o CRM Agro
    // não inclui ninguém além de 50.
    if (entram.length && convidados.length > MAX_CONVIDADOS) throw new LimiteDeConvidados();
    // Incluir alguém sairia como convite da conta Google do responsável; tirar
    // alguém, como cancelamento dela — só ele pode.
    if ((entram.length || saem.length) && outraPessoaNoGoogleDoResponsavel) throw new ConviteSoPeloResponsavel();
  }

  const data: Prisma.AppointmentUncheckedUpdateInput = {};
  // "Campos comuns" = o que o convidado vê (título, horário, local, descrição,
  // reunião online). Mudou algum: o convite/evento é atualizado e o carimbo
  // do conflito com o Google anda (decisão 5).
  let comuns = false;
  // Conteúdo do convite (o que o cliente lê) mudado por quem não é o responsável.
  let conteudoDoConvite = false;
  if (input.titulo !== undefined) {
    const t = input.titulo.trim();
    if (!t) throw new Error("título obrigatório");
    if (t !== antes.titulo) {
      data.titulo = t;
      comuns = true;
      conteudoDoConvite = true;
    }
  }
  if (input.descricao !== undefined) {
    const d = input.descricao?.trim() || null;
    // Compara sem os espaços das pontas (a nota importada do Google pode vir
    // com quebra de linha no fim): reenviar a mesma nota não é mudança.
    if (d !== (antes.descricao?.trim() || null)) {
      data.descricao = d;
      comuns = true;
      conteudoDoConvite = true;
    }
  }
  if (input.tipo !== undefined && input.tipo !== antes.tipo) {
    data.tipo = input.tipo;
    // Virar (ou deixar de ser) reunião online muda o Meet do evento.
    if (input.tipo === "reuniao_online" || antes.tipo === "reuniao_online") {
      comuns = true;
      conteudoDoConvite = true;
    }
  }
  // Horário ou antecedência mudaram: o trigger do banco recalcula `lembreteEm`
  // e zera `lembreteEnviadoEm` (compromisso remarcado ganha lembrete novo).
  if (input.inicio !== undefined) {
    const ini = new Date(input.inicio);
    if (isNaN(ini.getTime())) throw new Error("data inválida");
    if (!mesmoInstante(ini, antes.inicio)) {
      data.inicio = ini;
      comuns = true;
    }
  }
  if (input.fim !== undefined) {
    const f = input.fim ? new Date(input.fim) : null;
    if (f && isNaN(f.getTime())) throw new Error("data de fim inválida");
    if (!mesmoInstante(f, antes.fim)) {
      data.fim = f;
      comuns = true;
    }
  }
  if (extra.local !== undefined && (extra.local || null) !== antes.local) {
    data.local = extra.local || null;
    comuns = true;
    conteudoDoConvite = true;
  }
  if (conteudoDoConvite && outraPessoaNoGoogleDoResponsavel) throw new AlteracaoSoPeloResponsavel();
  if (extra.lembreteMin !== undefined) data.lembreteMin = extra.lembreteMin;
  if (extra.responsavelId !== undefined) {
    if (extra.responsavelId) await assertOwned("user", extra.responsavelId);
    data.responsavelId = extra.responsavelId;
  }
  // Trocou o responsável e o evento do Google que convidou já não está ligado
  // (a agenda do antigo foi desconectada): não há como cancelá-lo, e o canal
  // do convite deixa de ser aquele Google — passa a ser o .ics do time (com o
  // mesmo UID, `convitesICalUID`). Senão, quando o antigo reconectasse, o
  // evento religado voltaria a ser o canal e convidaria pela conta dele quem
  // outra pessoa incluiu no meio. Com o vínculo vivo, `propagarCompromisso`
  // cancela o evento antigo e decide o convite de novo.
  if (responsavelMudou && antes.convitesPorConexaoId && !antes.vinculos.some((v) => v.connectionId === antes.convitesPorConexaoId)) {
    data.convitesPorConexaoId = null;
  }
  if (input.contactId !== undefined) {
    await assertOwnedIfPresent("contact", input.contactId);
    data.contactId = input.contactId ?? null;
  }
  // Trocou o contato ou o tipo: a coordenada da visita segue o contato atual.
  if (input.contactId !== undefined || input.tipo !== undefined) {
    const tipo = input.tipo ?? antes.tipo;
    const contactId = input.contactId !== undefined ? (input.contactId ?? null) : antes.contactId;
    Object.assign(data, await coordenadaDoContato(tipo, contactId));
  }
  const conv = convidados !== undefined ? await substituirConvidados(id, antes.teamId, convidados) : { novos: [] as string[], mudou: false };
  if (comuns || conv.mudou) data.camposComunsEm = new Date();
  // Quem fez a alteração que o convidado vê: só o próprio responsável convida
  // pelo Google Agenda dele (colega/gestor → o convite vai pelo .ics do time).
  if (comuns || conv.mudou || responsavelMudou) data.alteradoPorId = autorDaAlteracao(ator);
  if (Object.keys(data).length) await db().appointment.update({ where: { id }, data });
  // Trocou o responsável: o evento muda de agenda (o antigo organizador cancela)
  // e os convidados precisam do convite novo.
  await propagarCompromisso(id, { comuns: comuns || conv.mudou || responsavelMudou, convidadosNovos: conv.novos });
  return lerDTO(id);
}

/**
 * Compromissos cujo AVISO venceu agora: pendentes, com o momento do aviso na
 * janela [-janelaMin, +1min]. O aviso é `lembreteEm` (início − lembreteMin);
 * sem lembrete (null), é o próprio início, como antes. Só os do usuário
 * logado e os "do time" (sem responsável). Usado pelo alerta na plataforma —
 * o cliente deduplica pelos ids já avisados.
 */
export async function listDueAppointments(janelaMin = 15): Promise<AppointmentDTO[]> {
  const d = db();
  const ator = getActor();
  const now = Date.now();
  const janela = { gte: new Date(now - janelaMin * 60 * 1000), lte: new Date(now + 60 * 1000) };
  const rows = await d.appointment.findMany({
    where: {
      status: "pendente",
      OR: [{ lembreteEm: janela }, { lembreteMin: null, inicio: janela }],
      ...(ator && !ator.system ? { AND: [{ OR: [{ responsavelId: ator.userId }, { responsavelId: null }] }] } : {}),
    },
    orderBy: { inicio: "asc" },
    select: SELECT,
    take: 100,
  });
  return toDTOs(rows);
}

/**
 * Marca status (concluir/cancelar/reabrir). Cancelar avisa os convidados
 * (decisão 6): pelo Google (`sendUpdates=all`) ou pelo .ics de cancelamento.
 */
export async function setAppointmentStatus(id: string, status: AppointmentStatus): Promise<void> {
  const ator = requireCan("agenda.write");
  await exigirCompromissoNoEscopo(id);
  const antes = await db().appointment.findUnique({
    where: { id },
    select: {
      status: true,
      responsavelId: true,
      convitesPorConexaoId: true,
      vinculos: { where: { cancelarEm: null }, select: { connectionId: true, origem: true } },
    },
  });
  if (!antes || antes.status === status) return;
  const cancelou = status === "cancelado";
  const reabriu = antes.status === "cancelado";
  // Reabrir um cancelado convida de novo pela conta Google do responsável: só
  // ele (cancelar, qualquer um que edita — os convidados precisam saber).
  if (reabriu && conviteNoGoogle(antes) && (ator.system || ator.userId !== antes.responsavelId)) {
    throw new AlteracaoSoPeloResponsavel("reabrir");
  }
  await db().appointment.update({
    where: { id },
    // Cancelar/reabrir é mudança que o convidado vê: anda o carimbo do conflito.
    data: { status, ...(cancelou || reabriu ? { camposComunsEm: new Date(), alteradoPorId: autorDaAlteracao(ator) } : {}) },
  });
  if (cancelou || reabriu) {
    await propagarCompromisso(id, { comuns: false, convidadosNovos: [], status: cancelou ? "cancelado" : "reaberto" });
  }
}

/**
 * Exclui o compromisso. O que está no Google Agenda (ou tem convidados) não
 * some do histórico (decisão 6): é CANCELADO — os convidados recebem o
 * cancelamento. Sem nada disso, apaga de vez, como antes.
 */
export async function deleteAppointment(id: string): Promise<void> {
  requireCan("agenda.write");
  // Fora do escopo de escrita: não faz nada (mesmo silêncio de "não existe").
  const alvo = await db().appointment.findFirst({
    where: { AND: [{ id }, escopoCompromisso({ escrita: true })] },
    select: { status: true, _count: { select: { vinculos: true, convidados: true } } },
  });
  if (!alvo) return;
  if (alvo._count.vinculos || alvo._count.convidados) {
    if (alvo.status !== "cancelado") await setAppointmentStatus(id, "cancelado");
    return;
  }
  await db().appointment.deleteMany({ where: { AND: [{ id }, escopoCompromisso({ escrita: true })] } });
}

/**
 * "Manter no CRM Agro" (3ª revisão do #169): o evento que veio da Agenda Google
 * da pessoa é de trabalho — deixa de ser só dela e o time passa a vê-lo (o
 * gestor, "ver tudo", os colegas convidados). Só a própria dona confirma.
 */
export async function confirmarDoGoogle(id: string): Promise<AppointmentDTO> {
  const ator = requireCan("agenda.write");
  if (ator.system) throw new ForbiddenError();
  await exigirCompromissoNoEscopo(id);
  const { count } = await db().appointment.updateMany({
    where: { id, responsavelId: ator.userId, privadoAteConfirmar: true },
    data: { privadoAteConfirmar: false },
  });
  if (count !== 1 && (await db().appointment.count({ where: { id, responsavelId: ator.userId } })) !== 1) {
    throw new OwnedNotFound("appointment", [id]);
  }
  return lerDTO(id);
}

/**
 * "Tirar do CRM Agro" um evento que veio da Agenda Google por engano (decisão 4,
 * revisão do #169): apaga o compromisso e o vínculo SÓ AQUI — nada vai ao
 * Google, ninguém é avisado, o evento na agenda da pessoa fica como está — e o
 * horário volta como "Ocupado" (marcado para não ser importado de novo). Só
 * quem pode alterar o compromisso e é dona da agenda de onde ele veio.
 */
export async function desvincularDoGoogle(id: string): Promise<void> {
  const ator = requireCan("agenda.write");
  if (ator.system) throw new ForbiddenError();
  await exigirCompromissoNoEscopo(id);
  const prisma = db();
  const a = await prisma.appointment.findUnique({
    where: { id },
    select: {
      titulo: true,
      inicio: true,
      fim: true,
      origem: true,
      vinculos: { select: { externalEventId: true, connectionId: true, origem: true, connection: { select: { userId: true } } } },
    },
  });
  const v = a?.vinculos.find((x) => x.connection.userId === ator.userId && (x.origem === "google" || x.origem === "convite"));
  if (!a || a.origem !== "google" || !v) throw new OwnedNotFound("appointment", [id]);
  const fim = a.fim && a.fim > a.inicio ? a.fim : new Date(a.inicio.getTime() + 60 * 60_000);
  await prisma.$transaction(async (tx) => {
    // Convidados e vínculos saem em cascata.
    await tx.appointment.deleteMany({ where: { id } });
    await tx.calendarBusyBlock.upsert({
      where: { connectionId_externalEventId: { connectionId: v.connectionId, externalEventId: v.externalEventId } },
      create: {
        userId: ator.userId,
        connectionId: v.connectionId,
        externalEventId: v.externalEventId,
        inicio: a.inicio,
        fim,
        titulo: a.titulo,
        naoImportar: true,
      } as Prisma.CalendarBusyBlockUncheckedCreateInput,
      update: { inicio: a.inicio, fim, titulo: a.titulo, naoImportar: true },
    });
  });
}
