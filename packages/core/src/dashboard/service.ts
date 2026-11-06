import { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, getCurrentUserId, SYSTEM_USER_ID, TenantContextRequiredError } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { getTeamConfigComCache } from "../motor-do-dia/team-config";
import { TIPOS_DE_TOQUE, sqlToqueDeSaida, whereContatoAbordado } from "../motor-do-dia/toque";
import { DEFAULT_TZ, zonedParts, zonedTimeToUtc } from "../motor-do-dia/tz";
import { dealsAbertosPorEtapa } from "../funnels/stats";
import { lerOuCalcularPainel } from "./cache";
import { chaveDaTarefa, diaNoFuso, idsFeitosNoDia, type KindDia } from "./tarefas-feitas";

import { chaveDoEscopo as chaveDoEscopoNaTela, sqlDoEscopo, whereDoEscopo } from "../tenancy/escopo";
import { escopoNegocio } from "../funnels/escopo";
/**
 * KPIs e listas do Painel. Puros (só @crmagro/db). Rodam dentro de runWithTeam/runAsDev.
 *
 * O "motor do dia" inclui: (a) deals parados há mais de 7 dias, (b) leads sem 1º
 * toque e, desde que o motor de fluxos está ativo, (c) follow-ups vencidos —
 * enrollments `active` cujo `nextRunAt` já passou (query em Enrollment.nextRunAt).
 *
 * Velocidade (item 2.3, DP-07): os números de Activity/Contact saem de UM SQL
 * agregado (`count(*) FILTER (WHERE ...)`, com `"teamId"` explícito — §12f),
 * compartilhado por kpis/prospecção/canal/taxas e guardado 30 s no Redis
 * (`dash:<teamId>:contagens`, ver ./cache). Deals abertos por `groupBy`/`aggregate`
 * em vez de trazer todos os deals para contar em JS. Antes: ~25 consultas por
 * render e todas as linhas de 7 dias de Activity na memória.
 *
 * Os limites de hoje/semana/mês são calculados no FUSO DO TIME (TeamConfig,
 * padrão America/Sao_Paulo). Antes eram no fuso do servidor (UTC em produção):
 * entre 21h e 0h o "hoje" do Painel já era o dia seguinte.
 *
 * O que conta como toque (F1A-03): o placar (prospecção, toques de hoje, canal,
 * gráfico da semana e taxa de resposta) conta só o toque de SAÍDA que tem prova,
 * por `sqlToqueDeSaida()` de `motor-do-dia/toque.ts`: WhatsApp e e-mail enviados e
 * ligação só quando o provedor comprovou (`Activity.meta.comprovada`). A lista do
 * dia, ao contrário, tira o contato por qualquer abordagem (`whereContatoAbordado()`),
 * inclusive a ligação declarada e a anotada. Nenhuma contagem de toque nasce aqui
 * dentro: as duas definições vêm de `toque.ts`.
 */

export type Period = "hoje" | "semana" | "mes";

const PERIODOS: readonly Period[] = ["hoje", "semana", "mes"];

/** Rótulo do dia da semana ("seg", "ter"...). Formatador criado uma vez (Intl é caro). */
const FMT_DIA_SEMANA = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "UTC" });

/** Limites do Painel no fuso do time. Instantes em UTC; `dia`/`periodo` são datas do fuso. */
type Limites = {
  dia: string; // "YYYY-MM-DD" de hoje (chave do cache)
  periodo: string; // "YYYY-MM" (casa com Goal.periodo)
  hoje: Date; // 00:00 de hoje
  seteDias: Date; // 00:00 de 6 dias atrás ("semana" = últimos 7 dias, incluindo hoje)
  segunda: Date; // 00:00 da segunda-feira desta semana (prospecção da semana)
  mes: Date; // 00:00 do dia 1º
  diasUteisMes: number; // seg–sex do mês (feriados ficam para uma iteração)
  grafico: { chave: string; label: string }[]; // os 7 dias do gráfico, do mais antigo a hoje
};

function limitesDoPainel(tz: string, agora = new Date()): Limites {
  const p = zonedParts(agora, tz);
  const meiaNoite = (dia: number) => zonedTimeToUtc(p.year, p.month, dia, 0, 0, tz);
  // Data-calendário do fuso representada em UTC (só para aritmética de dias).
  const data = (dia: number) => new Date(Date.UTC(p.year, p.month - 1, dia));
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const fimDoMes = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  let diasUteisMes = 0;
  for (let d = 1; d <= fimDoMes; d++) {
    const g = data(d).getUTCDay();
    if (g !== 0 && g !== 6) diasUteisMes++;
  }

  const grafico: Limites["grafico"] = [];
  for (let i = 6; i >= 0; i--) {
    const d = data(p.day - i);
    grafico.push({ chave: iso(d), label: FMT_DIA_SEMANA.format(d).replace(".", "") });
  }

  return {
    dia: iso(data(p.day)),
    periodo: `${p.year}-${String(p.month).padStart(2, "0")}`,
    hoje: meiaNoite(p.day),
    seteDias: meiaNoite(p.day - 6),
    segunda: meiaNoite(p.day - ((p.weekday + 6) % 7)), // 0 = segunda
    mes: meiaNoite(1),
    diasUteisMes,
    grafico,
  };
}

function inicioDoPeriodo(l: Limites, period: Period): Date {
  return period === "hoje" ? l.hoje : period === "semana" ? l.seteDias : l.mes;
}

/**
 * Contexto de cada serviço: client tenant, `teamId` e limites no fuso do time.
 * `db()` e `getCurrentTeamId()` são lidos ANTES de qualquer await (ALS eager).
 */
async function contextoDoPainel() {
  const prisma = db();
  const teamId = getCurrentTeamId();
  if (!teamId) throw new TenantContextRequiredError("painel", "(resolver)");
  const tz = (await getTeamConfigComCache()).timezone || DEFAULT_TZ;
  return { prisma, teamId, tz, limites: limitesDoPainel(tz) };
}

type Contexto = Awaited<ReturnType<typeof contextoDoPainel>>;

/** `timestamp(3)` do Prisma é UTC sem fuso: compara com o instante convertido para UTC. */
const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

type ContagemPeriodo = {
  whatsapp: number;
  email: number;
  call: number;
  respostas: number; // Activity de toque com direção "in"
  // Taxa de resposta por CONTATO: contatos prospectados no período e, destes,
  // quantos responderam depois do 1º toque do período. Antes a taxa dividia
  // mensagens recebidas por toques enviados — 4 mensagens de um contato só
  // davam 133% ("4 de 3"), e quem escreveu sem ser prospectado contava.
  prospectados: number;
  responderam: number;
  novosContatos: number;
};

/** Tudo o que o Painel conta em Activity/Contact, para os 3 períodos de uma vez. */
type Contagens = {
  prospSegunda: number; // prospecções desde segunda (ProspeccaoResumo.semana)
  toquesHoje: number; // toques de saída com prova hoje; a entrada não conta (kpis)
  clientes: number;
  totalContatos: number;
  periodos: Record<Period, ContagemPeriodo>;
};

type LinhaContagens = Record<string, bigint | number | null>;

/**
 * Um SQL só (Activity + Contact), com `"teamId"` explícito nas duas tabelas.
 * Cada coluna repete um `count` que o código antigo fazia separado — mesmos
 * filtros (`tipo IN toques`, `direcao`, `createdAt >= limite`).
 */
/**
 * Chave do cache do painel por escopo (F3): "tudo" ou a pessoa. Os números em
 * cache (contagens e atividade da semana) são só de contatos e atividades: o
 * "ver tudo" que vale é o de Contatos (os negócios não entram no cache).
 */
function chaveDoEscopo(): string {
  return chaveDoEscopoNaTela("contatos");
}

/** Atividades (SQL cru, tabela "Activity") só dos contatos do escopo (F3). */
function escopoAtividade(teamId: string): Prisma.Sql {
  const esc = sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true });
  if (esc === Prisma.empty) return Prisma.empty;
  return Prisma.sql` AND EXISTS (SELECT 1 FROM "Contact" c WHERE c.id = "Activity"."contactId" AND c."teamId" = ${teamId}${esc})`;
}

/** Contatos do escopo (ORM) para os blocos do painel (F3). */
function escopoContatoDoPainel(): Prisma.ContactWhereInput {
  return whereDoEscopo("contatos", "ownerId", { compartilhado: true }) as Prisma.ContactWhereInput;
}

async function calcularContagens({ prisma, teamId, limites: l }: Contexto): Promise<Contagens> {
  // F3: atividades dos contatos do escopo; contatos do escopo.
  const escAtiv = escopoAtividade(teamId);
  const escContato = sqlDoEscopo("contatos", '"Contact"', "ownerId", { compartilhado: true });
  const desde = l.seteDias < l.mes ? l.seteDias : l.mes;
  // A definição de "toque de saída com prova" é uma só (motor-do-dia/toque.ts): cada canal só acrescenta o `tipo`.
  const saida = sqlToqueDeSaida();
  // `Prisma.raw` só nos apelidos das colunas, montados da constante PERIODOS
  // (nunca de entrada do cliente); todo valor vai como parâmetro.
  const colunasActivity = PERIODOS.map((per) => {
    const ini = utc(inicioDoPeriodo(l, per));
    return Prisma.sql`
      count(*) FILTER (WHERE ${saida} AND tipo = 'whatsapp' AND "createdAt" >= ${ini}) AS ${Prisma.raw(`"${per}_whatsapp"`)},
      count(*) FILTER (WHERE ${saida} AND tipo = 'email' AND "createdAt" >= ${ini}) AS ${Prisma.raw(`"${per}_email"`)},
      count(*) FILTER (WHERE ${saida} AND tipo = 'call' AND "createdAt" >= ${ini}) AS ${Prisma.raw(`"${per}_call"`)},
      count(*) FILTER (WHERE direcao = 'in' AND "createdAt" >= ${ini}) AS ${Prisma.raw(`"${per}_respostas"`)}`;
  });
  const colunasTaxa = PERIODOS.map((per) => {
    const ini = utc(inicioDoPeriodo(l, per));
    return Prisma.sql`min("createdAt") FILTER (WHERE "createdAt" >= ${ini}) AS ${Prisma.raw(`"${per}_primeiro"`)}`;
  });
  const colunasTaxaTotal = PERIODOS.map(
    (per) => Prisma.sql`
      count(p.${Prisma.raw(`"${per}_primeiro"`)}) AS ${Prisma.raw(`"${per}_prospectados"`)},
      count(*) FILTER (WHERE r.ultima > p.${Prisma.raw(`"${per}_primeiro"`)}) AS ${Prisma.raw(`"${per}_responderam"`)}`,
  );
  const colunasContato = PERIODOS.map(
    (per) =>
      Prisma.sql`count(*) FILTER (WHERE "createdAt" >= ${utc(inicioDoPeriodo(l, per))}) AS ${Prisma.raw(`"${per}_novos"`)}`,
  );

  const [linha] = await prisma.$queryRaw<LinhaContagens[]>`
    WITH a AS (
      SELECT
        ${Prisma.join(colunasActivity, ",")},
        count(*) FILTER (WHERE ${saida} AND "createdAt" >= ${utc(l.segunda)}) AS "prospSegunda",
        count(*) FILTER (WHERE ${saida} AND "createdAt" >= ${utc(l.hoje)}) AS "toquesHoje"
      FROM "Activity"
      WHERE "teamId" = ${teamId}
        AND tipo IN ('whatsapp', 'email', 'call')
        AND "createdAt" >= ${utc(desde)}${escAtiv}
    ), p AS (
      -- 1º toque de saída COM PROVA de cada contato em cada período.
      SELECT "contactId", ${Prisma.join(colunasTaxa, ",")}
      FROM "Activity"
      WHERE "teamId" = ${teamId}
        AND ${saida}
        AND "createdAt" >= ${utc(desde)}${escAtiv}
      GROUP BY "contactId"
    ), r AS (
      -- Última resposta de cada contato: respondeu depois do 1º toque ⇔ última > 1º.
      SELECT "contactId", max("createdAt") AS ultima
      FROM "Activity"
      WHERE "teamId" = ${teamId}
        AND tipo IN ('whatsapp', 'email', 'call')
        AND direcao = 'in'
        AND "createdAt" >= ${utc(desde)}${escAtiv}
      GROUP BY "contactId"
    ), t AS (
      SELECT ${Prisma.join(colunasTaxaTotal, ",")}
      FROM p LEFT JOIN r ON r."contactId" = p."contactId"
    ), c AS (
      SELECT
        ${Prisma.join(colunasContato, ",")},
        count(*) FILTER (WHERE "relacionamentoStatus" = 'cliente') AS "clientes",
        count(*) AS "totalContatos"
      FROM "Contact"
      WHERE "teamId" = ${teamId}${escContato}
    )
    SELECT * FROM a CROSS JOIN t CROSS JOIN c`;

  const n = (k: string) => Number(linha?.[k] ?? 0);
  const periodos = Object.fromEntries(
    PERIODOS.map((per) => [
      per,
      {
        whatsapp: n(`${per}_whatsapp`),
        email: n(`${per}_email`),
        call: n(`${per}_call`),
        respostas: n(`${per}_respostas`),
        prospectados: n(`${per}_prospectados`),
        responderam: n(`${per}_responderam`),
        novosContatos: n(`${per}_novos`),
      },
    ]),
  ) as Record<Period, ContagemPeriodo>;
  return {
    prospSegunda: n("prospSegunda"),
    toquesHoje: n("toquesHoje"),
    clientes: n("clientes"),
    totalContatos: n("totalContatos"),
    periodos,
  };
}

/** Contagens do Painel com cache de 30 s por time (invalidado a cada mensagem). */
function contagens(ctx: Contexto): Promise<Contagens> {
  return lerOuCalcularPainel(ctx.teamId, "contagens", ctx.limites.dia, () => calcularContagens(ctx), chaveDoEscopo());
}

/** Prospecções (toques `out`) do período = soma dos canais. */
const prospeccoesDe = (c: ContagemPeriodo) => c.whatsapp + c.email + c.call;

export async function kpis(period: Period = "semana") {
  const ctx = await contextoDoPainel();
  const [cont, abertos] = await Promise.all([
    contagens(ctx),
    ctx.prisma.deal.aggregate({
      where: { AND: [{ status: "open" }, escopoNegocio()] },
      _count: { _all: true },
      _sum: { valor: true },
    }),
  ]);
  const { clientes, totalContatos } = cont;
  const conversao = totalContatos > 0 ? (clientes / totalContatos) * 100 : 0;

  return {
    toquesHoje: cont.toquesHoje,
    novosContatos: cont.periodos[period].novosContatos,
    negociosAtivos: { count: abertos._count._all, valor: Number(abertos._sum.valor ?? 0) },
    conversao,
    clientes,
    totalContatos,
  };
}

/**
 * Item da lista do dia. `chave` = `"<kind>:<id>:<YYYY-MM-DD>"` (dia no fuso do
 * time) — é o que `markTaskDone`/`undoTaskDone` recebem (produto §F).
 */
export type ItemDia =
  | {
      kind: "deal_parado";
      id: string;
      chave: string;
      contato: string;
      empresa: string | null;
      funil: string;
      funilId: string;
      etapa: string;
      valor: number;
      desde: Date;
    }
  | {
      kind: "lead_sem_toque";
      id: string;
      chave: string;
      contato: string;
      empresa: string | null;
      origem: string | null;
      criadoEm: Date;
    }
  | {
      kind: "followup_vencido";
      id: string; // enrollmentId
      chave: string;
      contatoId: string;
      contato: string;
      empresa: string | null;
      fluxo: string;
      fluxoId: string;
      venceuEm: Date; // nextRunAt (já vencido)
    };

/** Lista do dia de um usuário: o que falta e o que ele já marcou como feito hoje. */
export type ListaDoDiaComFeitas = { pendentes: ItemDia[]; feitas: ItemDia[] };

/** Filtro de id por tipo: `null` = não consulta esse tipo. */
type FiltroIds = Record<KindDia, Prisma.StringFilter | undefined | null>;

const LIMITE_POR_TIPO = 20;

/**
 * As 3 consultas da lista do dia, com o MESMO critério de sempre (deal parado há
 * 7 dias, lead novo sem toque, follow-up vencido) mais um filtro de id por tipo
 * — `notIn` para tirar as feitas das pendentes, `in` para buscar as feitas. As
 * feitas também passam pelo critério: se a condição deixou de valer (o lead foi
 * tocado), a tarefa some das duas listas.
 */
async function buscarItensDoDia(
  prisma: ReturnType<typeof db>,
  agora: Date,
  dia: string,
  filtro: FiltroIds,
  take: number | undefined,
): Promise<ItemDia[]> {
  const staleLimit = new Date(agora.getTime() - 7 * 86400_000);
  const vazio = Promise.resolve([] as never[]);

  const [dealsParados, leadsSemToque, followupsVencidos] = await Promise.all([
    filtro.deal_parado === null
      ? vazio
      : prisma.deal.findMany({
          where: { AND: [{ status: "open", enteredStageAt: { lt: staleLimit }, id: filtro.deal_parado }, escopoNegocio()] },
          include: { contact: true, stage: { include: { funnel: { select: { nome: true } } } } },
          orderBy: { enteredStageAt: "asc" },
          take,
        }),
    filtro.lead_sem_toque === null
      ? vazio
      : prisma.contact.findMany({
          where: {
            AND: [
              {
                relacionamentoStatus: "novo",
                // Qualquer abordagem tira o lead da lista (declarada, comprovada ou anotada), não só a que conta no placar.
                activities: { none: whereContatoAbordado() },
                id: filtro.lead_sem_toque,
              },
              escopoContatoDoPainel(),
            ],
          },
          orderBy: { createdAt: "desc" },
          take,
        }),
    // Follow-ups vencidos: enrollments ativos cujo próximo passo já era pra ter
    // rodado. `nextRunAt` é indexado (motor do dia / waits) — query barata.
    filtro.followup_vencido === null
      ? vazio
      : prisma.enrollment.findMany({
          where: { status: "active", nextRunAt: { lt: agora, not: null }, id: filtro.followup_vencido, contact: escopoContatoDoPainel() },
          include: {
            contact: { select: { nome: true, empresa: true } },
            flow: { select: { nome: true } },
          },
          orderBy: { nextRunAt: "asc" },
          take,
        }),
  ]);

  return [
    ...dealsParados.map<ItemDia>((d) => ({
      kind: "deal_parado",
      id: d.id,
      chave: chaveDaTarefa("deal_parado", d.id, dia),
      contato: d.contact.nome,
      empresa: d.contact.empresa,
      funil: d.stage.funnel.nome,
      funilId: d.stage.funnelId,
      etapa: d.stage.nome,
      valor: Number(d.valor),
      desde: d.enteredStageAt,
    })),
    ...leadsSemToque.map<ItemDia>((c) => ({
      kind: "lead_sem_toque",
      id: c.id,
      chave: chaveDaTarefa("lead_sem_toque", c.id, dia),
      contato: c.nome,
      empresa: c.empresa,
      origem: c.origem,
      criadoEm: c.createdAt,
    })),
    ...followupsVencidos.map<ItemDia>((e) => ({
      kind: "followup_vencido",
      id: e.id,
      chave: chaveDaTarefa("followup_vencido", e.id, dia),
      contatoId: e.contactId,
      contato: e.contact.nome,
      empresa: e.contact.empresa,
      fluxo: e.flow.nome,
      fluxoId: e.flowId,
      venceuEm: e.nextRunAt ?? agora,
    })),
  ];
}

/**
 * Lista do dia (motor do dia). Tarefa marcada como feita pelo usuário HOJE (no
 * fuso do time) sai das pendentes (produto §F).
 *
 * - `listaDoDia()` — formato de sempre (array das pendentes), para as telas que
 *   ainda não mostram as feitas; esconde as feitas do usuário do contexto.
 * - `listaDoDia({ userId })` — `{ pendentes, feitas }`. O `userId` tem de ser o
 *   da sessão (quem está no contexto): ninguém lê as marcas de outra pessoa.
 *
 * Pendentes: até 20 por tipo, sem as feitas (`notIn` na consulta, então as
 * feitas não "comem" vagas das 20). Feitas: por id, com o mesmo critério.
 */
export function listaDoDia(): Promise<ItemDia[]>;
export function listaDoDia(opts: { userId: string }): Promise<ListaDoDiaComFeitas>;
export async function listaDoDia(opts?: { userId: string }): Promise<ItemDia[] | ListaDoDiaComFeitas> {
  const prisma = db();
  const usuarioDoContexto = getCurrentUserId();
  if (opts && opts.userId !== usuarioDoContexto) {
    throw new ForbiddenError("A lista do dia só mostra as tarefas feitas do próprio usuário");
  }
  const userId = usuarioDoContexto && usuarioDoContexto !== SYSTEM_USER_ID ? usuarioDoContexto : null;
  const agora = new Date();
  const tz = (await getTeamConfigComCache()).timezone || DEFAULT_TZ;
  const dia = diaNoFuso(tz, agora);

  const feitos = userId ? await idsFeitosNoDia(prisma, userId, dia) : null;
  const sem = (kind: KindDia) => (feitos?.[kind].length ? { notIn: feitos[kind] } : undefined);
  const pendentes = await buscarItensDoDia(
    prisma,
    agora,
    dia,
    { deal_parado: sem("deal_parado"), lead_sem_toque: sem("lead_sem_toque"), followup_vencido: sem("followup_vencido") },
    LIMITE_POR_TIPO,
  );
  if (!opts) return pendentes;

  const so = (kind: KindDia) => (feitos?.[kind].length ? { in: feitos[kind] } : null);
  const filtroFeitas = { deal_parado: so("deal_parado"), lead_sem_toque: so("lead_sem_toque"), followup_vencido: so("followup_vencido") };
  const temFeitas = Object.values(filtroFeitas).some((f) => f !== null);
  const feitas = temFeitas ? await buscarItensDoDia(prisma, agora, dia, filtroFeitas, undefined) : [];
  return { pendentes, feitas };
}

export type DiaAtividade = { label: string; enviadas: number; recebidas: number; total: number };

/**
 * Atividade de toques por dia (últimos 7 dias) para o gráfico de área. Agrupa no
 * SQL pelo dia-calendário do fuso do time (antes: todas as linhas de 7 dias
 * vinham para a memória e eram contadas em JS). Cache de 30 s por time.
 */
export async function atividadeSemana(): Promise<DiaAtividade[]> {
  const ctx = await contextoDoPainel();
  const { prisma, teamId, tz, limites: l } = ctx;

  const escAtiv = escopoAtividade(teamId);
  return lerOuCalcularPainel(teamId, "dias", l.dia, async () => {
    const linhas = await prisma.$queryRaw<{ dia: string; enviadas: bigint; recebidas: bigint }[]>`
      SELECT
        to_char(date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text), 'YYYY-MM-DD') AS dia,
        count(*) FILTER (WHERE ${sqlToqueDeSaida()}) AS enviadas,
        count(*) FILTER (WHERE direcao = 'in') AS recebidas
      FROM "Activity"
      WHERE "teamId" = ${teamId}
        AND tipo IN ('whatsapp', 'email', 'call')
        AND direcao IN ('in', 'out')
        AND "createdAt" >= ${utc(l.seteDias)}${escAtiv}
      GROUP BY 1`;
    const porDia = new Map(linhas.map((r) => [r.dia, r]));
    return l.grafico.map(({ chave, label }) => {
      const r = porDia.get(chave);
      const enviadas = Number(r?.enviadas ?? 0);
      const recebidas = Number(r?.recebidas ?? 0);
      return { label, enviadas, recebidas, total: enviadas + recebidas };
    });
  }, chaveDoEscopo());
}

/**
 * Payload completo do Painel: KPIs + lista do dia + atividade da semana + funis
 * resumidos, numa chamada. Agrega os serviços acima para a rota de API
 * (`GET /api/dashboard`). Cada bloco já roda no contexto do time (db()).
 */
export async function getDashboardData(period: Period = "semana") {
  const [indicadores, itensDoDia, atividade, funis] = await Promise.all([
    kpis(period),
    listaDoDia(),
    atividadeSemana(),
    funilResumido(),
  ]);
  return { period, kpis: indicadores, listaDoDia: itensDoDia, atividadeSemana: atividade, funis };
}

// ────────────────────────────────────────────────────────────────────────────
// Prospecção — o eixo do Painel. "Prospecção" = uma tentativa de contato ATIVO
// (outbound) COM PROVA: Activity de saída de whatsapp/email, ou de ligação que o
// provedor comprovou (`sqlToqueDeSaida`, F1A-03). É o que a ferramenta mede:
// cadência de abordagem, não faturamento.
// A META é a BASE (piso a superar), não o teto — vem de Goal.toquesPorDia do
// período corrente (YYYY-MM); dia = base, semana = base × 5, mês = base × dias
// úteis (seg–sex) do mês.
// ────────────────────────────────────────────────────────────────────────────

const CANAL_LABEL: Record<(typeof TIPOS_DE_TOQUE)[number], string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  call: "Ligação",
};

/** Base diária de prospecção do time (Goal.toquesPorDia do período atual, no fuso do time). */
async function metaBaseDia({ prisma, limites }: Contexto): Promise<number> {
  const goal = await prisma.goal.findFirst({
    where: { periodo: limites.periodo },
    orderBy: { createdAt: "desc" },
    select: { toquesPorDia: true },
  });
  return goal?.toquesPorDia ?? 0;
}

export type ProspeccaoPeriodo = {
  feitas: number;
  base: number; // piso do período (0 = sem meta cadastrada)
  restantes: number; // max(0, base − feitas)
  pct: number; // feitas/base, pode passar de 100 (a meta é base, não teto)
  bateu: boolean; // já atingiu a base
};

function makeProspeccao(feitas: number, base: number): ProspeccaoPeriodo {
  return {
    feitas,
    base,
    restantes: Math.max(0, base - feitas),
    pct: base > 0 ? Math.round((feitas / base) * 100) : 0,
    bateu: base > 0 && feitas >= base,
  };
}

export type ProspeccaoResumo = {
  hoje: ProspeccaoPeriodo;
  semana: ProspeccaoPeriodo;
  mes: ProspeccaoPeriodo;
};

/** Prospecções feitas hoje / semana (desde segunda) / mês, cada uma vs. sua base. */
export async function prospeccaoResumo(): Promise<ProspeccaoResumo> {
  const ctx = await contextoDoPainel();
  const [baseDia, cont] = await Promise.all([metaBaseDia(ctx), contagens(ctx)]);
  return {
    hoje: makeProspeccao(prospeccoesDe(cont.periodos.hoje), baseDia),
    semana: makeProspeccao(cont.prospSegunda, baseDia * 5),
    mes: makeProspeccao(prospeccoesDe(cont.periodos.mes), baseDia * ctx.limites.diasUteisMes),
  };
}

export type CanalProspeccao = { canal: string; label: string; count: number; pct: number };

/** Prospecção por canal no período (sai do SQL agregado, com teamId explícito). */
export async function prospeccaoPorCanal(period: Period = "mes"): Promise<CanalProspeccao[]> {
  const ctx = await contextoDoPainel();
  const c = (await contagens(ctx)).periodos[period];
  const total = prospeccoesDe(c);
  return TIPOS_DE_TOQUE.map((t) => ({
    canal: t,
    label: CANAL_LABEL[t],
    count: c[t],
    pct: total > 0 ? Math.round((c[t] / total) * 100) : 0,
  })).sort((a, b) => b.count - a.count);
}

export type TaxasResumo = {
  respostaPct: number; // contatos que responderam / contatos prospectados no período (nunca > 100)
  conversaoPct: number; // clientes / total de contatos (acumulado)
  prospeccoes: number; // toques enviados no período
  respostas: number; // contatos prospectados no período que responderam
  contatosProspectados: number;
  clientes: number;
  totalContatos: number;
};

/** Taxas de prospecção: resposta (no período) e conversão (acumulada). */
export async function taxas(period: Period = "mes"): Promise<TaxasResumo> {
  const ctx = await contextoDoPainel();
  const cont = await contagens(ctx);
  const { clientes, totalContatos } = cont;
  const per = cont.periodos[period];
  const prospeccoes = prospeccoesDe(per);
  return {
    respostaPct: per.prospectados > 0 ? Math.round((per.responderam / per.prospectados) * 100) : 0,
    conversaoPct: totalContatos > 0 ? Math.round((clientes / totalContatos) * 100) : 0,
    prospeccoes,
    respostas: per.responderam,
    contatosProspectados: per.prospectados,
    clientes,
    totalContatos,
  };
}

export type AtividadeRecenteItem = {
  id: string;
  tipo: string;
  direcao: "in" | "out" | null;
  contato: string;
  contatoId: string;
  resumo: string;
  createdAt: Date;
};

/** Últimas atividades (histórico) para o feed "Atividade recente" do Painel. */
export async function atividadeRecente(limit = 8): Promise<AtividadeRecenteItem[]> {
  const prisma = db();
  const acts = await prisma.activity.findMany({
    where: { contact: escopoContatoDoPainel() },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { contact: { select: { id: true, nome: true } } },
  });
  return acts.map((a) => ({
    id: a.id,
    tipo: a.tipo,
    direcao: a.direcao ?? null,
    contato: a.contact?.nome ?? "—",
    contatoId: a.contactId,
    resumo: a.conteudo ?? "",
    createdAt: a.createdAt,
  }));
}

/** Funis resumidos: contagem + valor por etapa (mini-stacked-bar). */
export async function funilResumido() {
  const prisma = db();
  const [funis, porEtapa] = await Promise.all([
    prisma.funnel.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, nome: true, stages: { orderBy: { ordem: "asc" }, select: { id: true, nome: true } } },
      take: 6,
    }),
    dealsAbertosPorEtapa(prisma),
  ]);
  return funis.map((f) => {
    const etapas = f.stages.map((s) => ({ nome: s.nome, ...(porEtapa.get(s.id) ?? { count: 0, valor: 0 }) }));
    return {
      id: f.id,
      nome: f.nome,
      total: etapas.reduce((acc, e) => acc + e.count, 0),
      valor: etapas.reduce((acc, e) => acc + e.valor, 0),
      etapas: etapas.map((e) => ({ nome: e.nome, count: e.count })),
    };
  });
}
