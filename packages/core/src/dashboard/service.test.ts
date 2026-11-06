import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { basePrisma, db } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { limparToques, QUE_FICAM_NA_LISTA, QUE_SAEM_DA_LISTA, semearToques } from "../test-support/toque-cenario";

/**
 * Item 2.3 (DP-07) — Painel com SQL agregado, groupBy e cache Redis de 30 s.
 *
 * Teste de EQUIVALÊNCIA: o código antigo do Painel (copiado abaixo, como estava
 * na main antes do item) e o novo rodam sobre o mesmo cenário e têm de dar os
 * mesmos números. O código antigo usava o fuso do PROCESSO; o novo usa o fuso do
 * TIME. Para comparar, o antigo roda com `TZ` = fuso do time, e o novo com um
 * fuso de processo propositalmente diferente (Tóquio) — prova que o novo não
 * depende mais do fuso do servidor.
 *
 * O cenário põe atividades e contatos EXATAMENTE nas bordas (00:00 de hoje, de
 * 6 dias atrás, da segunda, do dia 1º e dos 7 dias do gráfico) e 1 ms antes de
 * cada uma: qualquer erro de fuso ou de `>=` muda algum número.
 *
 * F1A-03: o placar passou a contar ligação só com a prova do provedor
 * (`meta.comprovada = true`) e só toque de SAÍDA. O código antigo abaixo foi
 * ajustado para essa definição (escrita à mão aqui, de propósito independente de
 * `motor-do-dia/toque.ts`): o que o teste prova é que a troca para o SQL agregado
 * e o fuso do time continuam dando os mesmos números do critério antigo.
 *
 * O barramento de tempo real é mockado (nada de publicar no Redis de verdade).
 */
vi.mock("../events/redis-bus", () => ({ publishRealtime: vi.fn() }));

const { kpis, atividadeSemana, prospeccaoResumo, prospeccaoPorCanal, taxas, funilResumido, getDashboardData, listaDoDia } =
  await import("./service");
const { listFunnelsResumo } = await import("../funnels/service");
const { invalidarPainel, lerOuCalcularPainel } = await import("./cache");
const { emitConversationEvent } = await import("../conversations/events");
const { redisCache } = await import("../shared/redis-cache");

type Period = "hoje" | "semana" | "mes";
const PERIODOS: Period[] = ["hoje", "semana", "mes"];

const TEAM_A = "00000000-0000-0000-0000-0000000003a1"; // São Paulo (sem TeamConfig → padrão)
const TEAM_B = "00000000-0000-0000-0000-0000000003a2"; // dois times
const TEAM_C = "00000000-0000-0000-0000-0000000003a3"; // Manaus (TeamConfig.timezone)
const TIMES = [TEAM_A, TEAM_B, TEAM_C];
const FUSO: Record<string, string> = {
  [TEAM_A]: "America/Sao_Paulo",
  [TEAM_B]: "America/Sao_Paulo",
  [TEAM_C]: "America/Manaus",
};
/** Fuso do PROCESSO ao rodar o código novo: longe do Brasil de propósito. */
const FUSO_SERVIDOR_ESTRANHO = "Asia/Tokyo";

const emTime = <T>(teamId: string, fn: () => Promise<T>) => runWithTeam(teamId, fn);

// ─── Código ANTIGO (main antes do item 2.3), só para comparação ────────────

const TOUCH_TYPES = ["whatsapp", "email", "call"] as const;
/** Ligação só conta com a prova do provedor; WhatsApp e e-mail de saída contam sempre. */
const LIGACAO_COMPROVADA: Prisma.ActivityWhereInput = { tipo: "call", meta: { path: ["comprovada"], equals: true } };
const PROSPECCAO_WHERE: Prisma.ActivityWhereInput = {
  direcao: "out",
  OR: [{ tipo: { in: ["whatsapp", "email"] } }, LIGACAO_COMPROVADA],
};

const legado = {
  periodStart(period: Period): Date {
    const now = new Date();
    switch (period) {
      case "hoje":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      case "semana": {
        const d = new Date(now);
        d.setDate(d.getDate() - 6);
        d.setHours(0, 0, 0, 0);
        return d;
      }
      case "mes":
        return new Date(now.getFullYear(), now.getMonth(), 1);
    }
  },
  startOfToday(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  },
  startOfWeek(): Date {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  },
  startOfMonth(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  },
  weekdaysInMonth(): number {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    let c = 0;
    for (const d = new Date(now.getFullYear(), now.getMonth(), 1); d < end; d.setDate(d.getDate() + 1)) {
      const g = d.getDay();
      if (g !== 0 && g !== 6) c++;
    }
    return c;
  },
  async kpis(period: Period) {
    const prisma = db();
    const since = legado.periodStart(period);
    const [toquesHoje, novosContatos, dealsAbertos, clientes, totalContatos] = await Promise.all([
      // Só toque de saída com prova (a entrada deixou de contar em "toques hoje").
      prisma.activity.count({ where: { ...PROSPECCAO_WHERE, createdAt: { gte: legado.startOfToday() } } }),
      prisma.contact.count({ where: { createdAt: { gte: since } } }),
      prisma.deal.findMany({ where: { status: "open" }, select: { valor: true } }),
      prisma.contact.count({ where: { relacionamentoStatus: "cliente" } }),
      prisma.contact.count(),
    ]);
    return {
      toquesHoje,
      novosContatos,
      negociosAtivos: { count: dealsAbertos.length, valor: dealsAbertos.reduce((a, d) => a + Number(d.valor), 0) },
      conversao: totalContatos > 0 ? (clientes / totalContatos) * 100 : 0,
      clientes,
      totalContatos,
    };
  },
  async atividadeSemana() {
    const prisma = db();
    const since = new Date();
    since.setDate(since.getDate() - 6);
    since.setHours(0, 0, 0, 0);
    const acts = await prisma.activity.findMany({
      where: { tipo: { in: [...TOUCH_TYPES] }, createdAt: { gte: since } },
      select: { createdAt: true, direcao: true, tipo: true, meta: true },
    });
    const days = [];
    const fmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const noDia = acts.filter((a) => a.createdAt >= d && a.createdAt < next);
      const comprovada = (a: (typeof acts)[number]) => (a.meta as { comprovada?: unknown } | null)?.comprovada === true;
      const enviadas = noDia.filter((a) => a.direcao === "out" && (a.tipo !== "call" || comprovada(a))).length;
      const recebidas = noDia.filter((a) => a.direcao === "in").length;
      days.push({ label: fmt.format(d).replace(".", ""), enviadas, recebidas, total: enviadas + recebidas });
    }
    return days;
  },
  async metaBaseDia() {
    const now = new Date();
    const periodo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const goal = await db().goal.findFirst({ where: { periodo }, orderBy: { createdAt: "desc" } });
    return goal?.toquesPorDia ?? 0;
  },
  makeProspeccao(feitas: number, base: number) {
    return {
      feitas,
      base,
      restantes: Math.max(0, base - feitas),
      pct: base > 0 ? Math.round((feitas / base) * 100) : 0,
      bateu: base > 0 && feitas >= base,
    };
  },
  async prospeccaoResumo() {
    const prisma = db();
    const baseDia = await legado.metaBaseDia();
    const [hoje, semana, mes] = await Promise.all([
      prisma.activity.count({ where: { ...PROSPECCAO_WHERE, createdAt: { gte: legado.startOfToday() } } }),
      prisma.activity.count({ where: { ...PROSPECCAO_WHERE, createdAt: { gte: legado.startOfWeek() } } }),
      prisma.activity.count({ where: { ...PROSPECCAO_WHERE, createdAt: { gte: legado.startOfMonth() } } }),
    ]);
    return {
      hoje: legado.makeProspeccao(hoje, baseDia),
      semana: legado.makeProspeccao(semana, baseDia * 5),
      mes: legado.makeProspeccao(mes, baseDia * legado.weekdaysInMonth()),
    };
  },
  async prospeccaoPorCanal(period: Period) {
    const prisma = db();
    const since = legado.periodStart(period);
    const counts = await Promise.all(
      TOUCH_TYPES.map((t) =>
        prisma.activity.count({
          where: { tipo: t, direcao: "out", createdAt: { gte: since }, ...(t === "call" ? { meta: LIGACAO_COMPROVADA.meta } : {}) },
        }),
      ),
    );
    const total = counts.reduce((a, c) => a + c, 0);
    const label = { whatsapp: "WhatsApp", email: "E-mail", call: "Ligação" };
    return TOUCH_TYPES.map((t, i) => ({
      canal: t,
      label: label[t],
      count: counts[i]!,
      pct: total > 0 ? Math.round((counts[i]! / total) * 100) : 0,
    })).sort((a, b) => b.count - a.count);
  },
  async taxas(period: Period) {
    const prisma = db();
    const since = legado.periodStart(period);
    const [prospeccoes, saidas, entradas, clientes, totalContatos] = await Promise.all([
      prisma.activity.count({ where: { ...PROSPECCAO_WHERE, createdAt: { gte: since } } }),
      prisma.activity.findMany({ where: { ...PROSPECCAO_WHERE, createdAt: { gte: since } }, select: { contactId: true, createdAt: true } }),
      prisma.activity.findMany({ where: { tipo: { in: [...TOUCH_TYPES] }, direcao: "in", createdAt: { gte: since } }, select: { contactId: true, createdAt: true } }),
      prisma.contact.count({ where: { relacionamentoStatus: "cliente" } }),
      prisma.contact.count(),
    ]);
    // Taxa por contato: prospectado no período e respondeu depois do 1º toque do período.
    const primeiro = new Map<string, number>();
    for (const a of saidas) primeiro.set(a.contactId, Math.min(primeiro.get(a.contactId) ?? Infinity, a.createdAt.getTime()));
    const responderam = new Set(entradas.filter((a) => a.createdAt.getTime() > (primeiro.get(a.contactId) ?? Infinity)).map((a) => a.contactId));
    return {
      respostaPct: primeiro.size > 0 ? Math.round((responderam.size / primeiro.size) * 100) : 0,
      conversaoPct: totalContatos > 0 ? Math.round((clientes / totalContatos) * 100) : 0,
      prospeccoes,
      respostas: responderam.size,
      contatosProspectados: primeiro.size,
      clientes,
      totalContatos,
    };
  },
  async funilResumido() {
    const funis = await db().funnel.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        stages: { orderBy: { ordem: "asc" }, include: { deals: { where: { status: "open" }, select: { valor: true } } } },
      },
      take: 6,
    });
    return funis.map((f) => ({
      id: f.id,
      nome: f.nome,
      total: f.stages.reduce((acc, s) => acc + s.deals.length, 0),
      valor: f.stages.reduce((acc, s) => acc + s.deals.reduce((a, d) => a + Number(d.valor), 0), 0),
      etapas: f.stages.map((s) => ({ nome: s.nome, count: s.deals.length })),
    }));
  },
  /** listFunnelsWithStats + a conta que a tela de funis fazia em cima dele. */
  async funisComTotais() {
    const funis = await db().funnel.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        stages: { orderBy: { ordem: "asc" }, include: { deals: { where: { status: "open" }, select: { valor: true } } } },
      },
    });
    return funis.map((f) => ({
      id: f.id,
      total: f.stages.reduce((a, s) => a + s.deals.length, 0),
      valor: f.stages.reduce((a, s) => a + s.deals.reduce((b, d) => b + Number(d.valor), 0), 0),
      stages: f.stages.map((s) => ({
        id: s.id,
        count: s.deals.length,
        valor: s.deals.reduce((b, d) => b + Number(d.valor), 0),
      })),
    }));
  },
};

// ─── Cenário ────────────────────────────────────────────────────────────────

/** Roda `fn` com o fuso do processo trocado (Node relê o `TZ` na hora). */
async function comFuso<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("TZ", tz);
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

/** Bordas dos períodos no fuso atual do processo (mesma conta do código antigo). */
function bordas(): Date[] {
  const hoje = legado.startOfToday();
  const dias = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    return d; // 00:00 de hoje, ontem, ... 7 dias atrás
  });
  const mesPassado = legado.startOfMonth();
  mesPassado.setMonth(mesPassado.getMonth() - 1);
  return [...dias, legado.startOfWeek(), legado.startOfMonth(), mesPassado];
}

/**
 * [tipo, direção, meta]. A ligação de saída aparece 4 vezes: sem marcador, com `comprovada: true` (a única que conta),
 * com `false` e com o TEXTO "true" (que também não conta).
 */
const TIPOS_DIRECOES: readonly (readonly ["whatsapp" | "email" | "call" | "note" | "stage_change", "in" | "out" | null, Prisma.InputJsonObject?])[] = [
  ["whatsapp", "out"],
  ["email", "out"],
  ["call", "out"],
  ["call", "out", { comprovada: true }],
  ["call", "out", { comprovada: false }],
  ["call", "out", { comprovada: "true" }],
  ["whatsapp", "in"],
  ["email", "in"],
  ["call", null],
  ["call", null, { comprovada: true }],
  ["note", "out"],
  ["stage_change", null],
];

/**
 * Semeia o time: atividades em cada borda e 1 ms antes (× `peso`), contatos
 * idem (clientes e novos), 2 funis com deals abertos/ganhos/perdidos e a meta
 * do mês. Valores dos deals exatos em binário (x,25/x,5) para a soma em JS do
 * código antigo não ter ruído de ponto flutuante.
 */
async function semear(teamId: string, peso: number) {
  await comFuso(FUSO[teamId]!, async () => {
    const agora = new Date();
    const base = await basePrisma.contact.create({
      data: { teamId, nome: "Base do cenário", createdAt: new Date(agora.getTime() - 90 * 86_400_000) },
    });
    const instantes = bordas().flatMap((b) => [b, new Date(b.getTime() - 1)]);
    instantes.push(new Date(agora.getTime() - 60_000));

    const atividades = instantes.flatMap((createdAt) =>
      TIPOS_DIRECOES.flatMap(([tipo, direcao, meta]) =>
        Array.from({ length: peso }, () => ({ teamId, contactId: base.id, tipo, direcao, createdAt, ...(meta ? { meta } : {}) })),
      ),
    );
    await basePrisma.activity.createMany({ data: atividades });

    await basePrisma.contact.createMany({
      data: instantes.flatMap((createdAt, i) =>
        Array.from({ length: peso }, (_, j) => ({
          teamId,
          nome: `Contato ${i}-${j}`,
          createdAt,
          relacionamentoStatus: (i + j) % 3 === 0 ? ("cliente" as const) : ("novo" as const),
        })),
      ),
    });

    const hoje = new Date();
    const periodo = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
    await basePrisma.goal.createMany({
      data: [
        { teamId, periodo: "2020-01", metaValor: 0, toquesPorDia: 99 },
        { teamId, periodo, metaValor: 1000, toquesPorDia: 7 * peso },
      ],
    });

    for (const [f, nome] of ["Pré-vendas", "Vendas"].entries()) {
      // createdAt explícito: a ordem dos funis (createdAt asc) não pode empatar.
      const funil = await basePrisma.funnel.create({
        data: { teamId, nome, tipo: "vendas", codigo: `f${f}`, createdAt: new Date(agora.getTime() - (10 - f) * 1000) },
      });
      for (let s = 0; s < 3; s++) {
        const etapa = await basePrisma.stage.create({
          data: { teamId, funnelId: funil.id, nome: `Etapa ${s}`, ordem: s, codigo: `e${s}` },
        });
        // Etapa 2 do 1º funil fica sem deal aberto (count 0 tem de aparecer).
        const status = f === 0 && s === 2 ? (["won", "lost"] as const) : (["open", "open", "won", "lost"] as const);
        await basePrisma.deal.createMany({
          data: status.flatMap((st, k) =>
            Array.from({ length: peso }, () => ({
              teamId,
              funnelId: funil.id,
              stageId: etapa.id,
              contactId: base.id,
              status: st,
              valor: 100.25 * (s + 1) + 0.5 * k,
            })),
          ),
        });
      }
    }
  });
}

async function limpar() {
  const w = { teamId: { in: TIMES } };
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.goal.deleteMany({ where: w });
  await basePrisma.teamConfig.deleteMany({ where: w });
}

async function redisPronto() {
  const r = redisCache();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
}

/** Tudo que o Painel mostra, pelo código NOVO (fuso do processo = Tóquio). */
function painelNovo(teamId: string) {
  return comFuso(FUSO_SERVIDOR_ESTRANHO, () =>
    emTime(teamId, async () => ({
      resumo: await prospeccaoResumo(),
      semana: await atividadeSemana(),
      funil: await funilResumido(),
      funis: (await listFunnelsResumo()).map((f) => ({
        id: f.id,
        total: f.total,
        valor: f.valor,
        stages: f.stages.map((s) => ({ id: s.id, count: s.count, valor: s.valor })),
      })),
      porPeriodo: await Promise.all(
        PERIODOS.map(async (p) => ({ kpis: await kpis(p), canal: await prospeccaoPorCanal(p), taxas: await taxas(p) })),
      ),
    })),
  );
}

/** O mesmo, pelo código ANTIGO (fuso do processo = fuso do time). */
function painelLegado(teamId: string) {
  return comFuso(FUSO[teamId]!, () =>
    emTime(teamId, async () => ({
      resumo: await legado.prospeccaoResumo(),
      semana: await legado.atividadeSemana(),
      funil: await legado.funilResumido(),
      funis: await legado.funisComTotais(),
      porPeriodo: await Promise.all(
        PERIODOS.map(async (p) => ({
          kpis: await legado.kpis(p),
          canal: await legado.prospeccaoPorCanal(p),
          taxas: await legado.taxas(p),
        })),
      ),
    })),
  );
}

beforeAll(async () => {
  for (const id of TIMES) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Painel 2.3 (${id.slice(-3)})` } });
  }
  await limpar();
  await basePrisma.teamConfig.create({ data: { teamId: TEAM_C, timezone: FUSO[TEAM_C]! } });
  await semear(TEAM_A, 1);
  await semear(TEAM_B, 2);
  await semear(TEAM_C, 1);
  await redisPronto();
  for (const id of TIMES) await invalidarPainel(id);
}, 60_000);

afterEach(async () => {
  for (const id of TIMES) await invalidarPainel(id);
});

afterAll(async () => {
  await limpar();
});

describe("Painel — equivalência com o código antigo", () => {
  it("time em São Paulo: mesmos números em todos os blocos e períodos", async () => {
    const novo = await painelNovo(TEAM_A);
    const antigo = await painelLegado(TEAM_A);
    expect(novo).toEqual(antigo);
    // O cenário não é trivial: há prospecção em todos os períodos e deals abertos.
    expect(novo.resumo.hoje.feitas).toBeGreaterThan(0);
    expect(novo.resumo.semana.base).toBe(35);
    // A ligação com prova existe no cenário e aparece no canal; as sem prova ficaram de fora (o oracle também as ignora).
    expect(novo.porPeriodo[2]!.canal.find((c) => c.canal === "call")!.count).toBeGreaterThan(0);
    expect(novo.porPeriodo[2]!.kpis.negociosAtivos.count).toBeGreaterThan(0);
    expect(novo.semana.some((d) => d.total > 0)).toBe(true);
    expect(novo.funil[0]!.etapas[2]!.count).toBe(0);
  });

  it("time com outro fuso (TeamConfig = Manaus): limites no fuso do time", async () => {
    const novo = await painelNovo(TEAM_C);
    const antigo = await painelLegado(TEAM_C);
    expect(novo).toEqual(antigo);
  });

  it("getDashboardData (rota /api/dashboard) monta os mesmos blocos", async () => {
    const dados = await comFuso(FUSO_SERVIDOR_ESTRANHO, () => emTime(TEAM_A, () => getDashboardData("mes")));
    const antigo = await comFuso(FUSO[TEAM_A]!, () =>
      emTime(TEAM_A, async () => ({
        kpis: await legado.kpis("mes"),
        semana: await legado.atividadeSemana(),
        funis: await legado.funilResumido(),
      })),
    );
    expect(dados.kpis).toEqual(antigo.kpis);
    expect(dados.atividadeSemana).toEqual(antigo.semana);
    expect(dados.funis).toEqual(antigo.funis);
  });
});

describe("Painel — dois times", () => {
  it("cada time vê só os próprios números (SQL com teamId explícito + groupBy do tenant)", async () => {
    const a = await painelNovo(TEAM_A);
    const b = await painelNovo(TEAM_B);
    expect(b).toEqual(await painelLegado(TEAM_B));
    // B foi semeado com o dobro de tudo: se o A enxergasse o B, não bateria.
    expect(b.resumo.hoje.feitas).toBe(2 * a.resumo.hoje.feitas);
    expect(b.porPeriodo[2]!.kpis.totalContatos).toBe(2 * a.porPeriodo[2]!.kpis.totalContatos - 1);
    expect(b.porPeriodo[2]!.kpis.negociosAtivos.count).toBe(2 * a.porPeriodo[2]!.kpis.negociosAtivos.count);
    // Os funis de um não aparecem no outro.
    const idsA = new Set(a.funis.map((f) => f.id));
    expect(b.funis.some((f) => idsA.has(f.id))).toBe(false);
  });
});

describe("Painel — cache Redis de 30 s", () => {
  it("serve do cache e recalcula depois que uma mensagem invalida", async () => {
    const antes = await emTime(TEAM_A, () => prospeccaoResumo());
    const diasAntes = await emTime(TEAM_A, () => atividadeSemana());

    // Grava uma prospecção direto no banco, sem evento: o Painel ainda mostra o cache.
    const contato = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM_A } });
    const nova = await basePrisma.activity.create({
      data: { teamId: TEAM_A, contactId: contato.id, tipo: "whatsapp", direcao: "out" },
    });
    expect(await emTime(TEAM_A, () => prospeccaoResumo())).toEqual(antes);
    expect(await emTime(TEAM_A, () => atividadeSemana())).toEqual(diasAntes);

    // A mensagem chega pelo caminho normal (emitConversationEvent) → invalida.
    const ger = await redisCache().get(`dash:${TEAM_A}:ger`);
    await emTime(TEAM_A, async () =>
      emitConversationEvent({
        type: "message:sent",
        channelAccountId: "c",
        conversationId: "c",
        message: { id: "m", direcao: "out", conteudo: "oi", createdAt: new Date().toISOString() },
      }),
    );
    await vi.waitFor(async () => expect(await redisCache().get(`dash:${TEAM_A}:ger`)).not.toBe(ger));

    const depois = await emTime(TEAM_A, () => prospeccaoResumo());
    expect(depois.hoje.feitas).toBe(antes.hoje.feitas + 1);
    expect(depois.mes.feitas).toBe(antes.mes.feitas + 1);
    const diasDepois = await emTime(TEAM_A, () => atividadeSemana());
    expect(diasDepois[6]!.enviadas).toBe(diasAntes[6]!.enviadas + 1);

    // Invalidar o A não mexe no cache do B (chave por time). Compara a geração do B ANTES e DEPOIS de
    // invalidar o A: comparar o B com o A dependia do histórico do Redis (num Redis reaproveitado entre
    // rodadas os dois contadores podiam chegar ao mesmo número, e o teste quebrava sem defeito nenhum).
    const gerB = await redisCache().get(`dash:${TEAM_B}:ger`);
    const gerAntesDoSegundo = await redisCache().get(`dash:${TEAM_A}:ger`);
    await emTime(TEAM_A, async () =>
      emitConversationEvent({
        type: "message:sent",
        channelAccountId: "c",
        conversationId: "c",
        message: { id: "m2", direcao: "out", conteudo: "oi", createdAt: new Date().toISOString() },
      }),
    );
    await vi.waitFor(async () => expect(await redisCache().get(`dash:${TEAM_A}:ger`)).not.toBe(gerAntesDoSegundo));
    expect(await redisCache().get(`dash:${TEAM_B}:ger`)).toBe(gerB);

    await basePrisma.activity.delete({ where: { id: nova.id } });
  });

  it("cálculo que termina depois da invalidação não recoloca o número velho", async () => {
    let liberar!: () => void;
    const segurado = new Promise<void>((ok) => (liberar = ok));
    const lento = lerOuCalcularPainel(TEAM_B, "contagens", "2026-01-01", async () => {
      await segurado;
      return "velho";
    }, "tudo");
    await new Promise((ok) => setTimeout(ok, 50)); // o cálculo já leu a geração
    await invalidarPainel(TEAM_B); // mensagem nova no meio do cálculo
    liberar();
    expect(await lento).toBe("velho");
    const proximo = await lerOuCalcularPainel(TEAM_B, "contagens", "2026-01-01", async () => "novo", "tudo");
    expect(proximo).toBe("novo");
  });

  it("chamadas em paralelo (como no render do Painel) fazem um cálculo só", async () => {
    const calcular = vi.fn(async () => {
      await new Promise((ok) => setTimeout(ok, 30));
      return 42;
    });
    const r = await Promise.all([1, 2, 3].map(() => lerOuCalcularPainel(TEAM_C, "dias", "2026-01-01", calcular, "tudo")));
    expect(r).toEqual([42, 42, 42]);
    expect(calcular).toHaveBeenCalledTimes(1);
  });
});

describe("Painel — taxa de resposta por contato", () => {
  // Produção 27/09: 4 mensagens recebidas de UM contato contra 3 toques davam
  // "133% (4 de 3)". A taxa é por contato: prospectado no período e respondeu
  // depois do 1º toque; quem escreveu sem ser prospectado não conta.
  const TEAM = "00000000-0000-0000-0000-0000000008a1";
  const w = { teamId: TEAM };

  afterAll(async () => {
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
  });

  it("várias respostas do mesmo contato contam uma vez, e a taxa nunca passa de 100%", async () => {
    await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Painel taxa (test)" } });
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
    const min = (m: number) => new Date(Date.now() - m * 60_000);
    const [respondeu, calado, escreveuSozinho] = await Promise.all(
      ["Respondeu", "Calado", "Escreveu sozinho"].map((nome) => basePrisma.contact.create({ data: { teamId: TEAM, nome } })),
    );
    await basePrisma.activity.createMany({
      data: [
        { teamId: TEAM, contactId: respondeu!.id, tipo: "whatsapp", direcao: "out", createdAt: min(5) },
        ...[4, 3, 2, 1].map((m) => ({ teamId: TEAM, contactId: respondeu!.id, tipo: "whatsapp" as const, direcao: "in" as const, createdAt: min(m) })),
        { teamId: TEAM, contactId: calado!.id, tipo: "whatsapp", direcao: "out", createdAt: min(5) },
        { teamId: TEAM, contactId: calado!.id, tipo: "email", direcao: "out", createdAt: min(4) },
        { teamId: TEAM, contactId: escreveuSozinho!.id, tipo: "whatsapp", direcao: "in", createdAt: min(2) },
      ],
    });
    await invalidarPainel(TEAM);
    const t = await emTime(TEAM, () => taxas("semana"));
    expect(t).toMatchObject({ prospeccoes: 3, contatosProspectados: 2, respostas: 1, respostaPct: 50 });
    expect(t).toEqual(await emTime(TEAM, () => legado.taxas("semana")));
  });
});

describe("Painel e lista do dia: fonte única do toque (F1A-03)", () => {
  // O placar conta só toque de saída com prova; a lista do dia tira o contato por qualquer abordagem.
  // Cenário (test-support/toque-cenario.ts): ligação declarada, ligação comprovada, WhatsApp recebido, anotação de ligação
  // fora do CRM Agro, nota comum, ligação sem direção e um contato sem nada. O time B tem o mesmo cenário mais 3 ligações comprovadas.
  const A = "00000000-0000-0000-0000-00000f1a3001";
  const B = "00000000-0000-0000-0000-00000f1a3002";
  let ca: Awaited<ReturnType<typeof semearToques>>;
  let cb: Awaited<ReturnType<typeof semearToques>>;

  beforeAll(async () => {
    for (const [id, name] of [[A, "Toque A (F1A-03)"], [B, "Toque B (F1A-03)"]] as const) {
      await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
    }
    await limparToques(basePrisma, [A, B]);
    ca = await semearToques(basePrisma, A);
    cb = await semearToques(basePrisma, B);
    await basePrisma.activity.createMany({
      data: [1, 2, 3].map(() => ({ teamId: B, contactId: cb.semNada, tipo: "call" as const, direcao: "out" as const, meta: { comprovada: true } })),
    });
    for (const id of [A, B]) await invalidarPainel(id);
  }, 30_000);

  afterAll(async () => {
    await limparToques(basePrisma, [A, B]);
    for (const id of [A, B]) await invalidarPainel(id);
  });

  const painel = (teamId: string) =>
    emTime(teamId, async () => {
      await invalidarPainel(teamId);
      return {
        resumo: await prospeccaoResumo(),
        canal: await prospeccaoPorCanal("mes"),
        semana: await atividadeSemana(),
        kpi: await kpis("semana"),
        taxa: await taxas("semana"),
      };
    });

  it("a ligação sem prova não entra no placar; só a comprovada conta (uma vez)", async () => {
    const p = await painel(A);
    expect(p.resumo.hoje.feitas).toBe(1);
    expect(p.resumo.semana.feitas).toBe(1);
    expect(p.resumo.mes.feitas).toBe(1);
    expect(p.canal.map((c) => [c.canal, c.count])).toEqual(expect.arrayContaining([["call", 1], ["whatsapp", 0], ["email", 0]]));
    expect(p.canal.find((c) => c.canal === "call")!.label).toBe("Ligação");
    // O gráfico da semana: 1 enviada (a comprovada) e 1 recebida (o WhatsApp do contato "entrada") hoje.
    expect(p.semana[6]).toMatchObject({ enviadas: 1, recebidas: 1, total: 2 });
    // A taxa de resposta parte do 1º toque COM prova: um contato prospectado, ninguém respondeu.
    expect(p.taxa).toMatchObject({ prospeccoes: 1, contatosProspectados: 1, respostas: 0, respostaPct: 0 });
  });

  it('"toques hoje" não conta a mensagem recebida', async () => {
    const p = await painel(A);
    expect(p.kpi.toquesHoje).toBe(1);
  });

  it("a lista do dia tira quem foi abordado (declarada, comprovada e anotada) e mantém os outros", async () => {
    const pendentes = await emTime(A, () => listaDoDia());
    const leads = pendentes.filter((i) => i.kind === "lead_sem_toque").map((i) => i.id);
    expect([...leads].sort()).toEqual(QUE_FICAM_NA_LISTA.map((k) => ca[k]).sort());
    for (const k of QUE_SAEM_DA_LISTA) expect(leads, `${k} deveria sair da lista`).not.toContain(ca[k]);
  });

  it("dois times: cada um vê só os próprios toques e a própria lista", async () => {
    const [pa, pb] = [await painel(A), await painel(B)];
    expect(pa.resumo.hoje.feitas).toBe(1);
    expect(pb.resumo.hoje.feitas).toBe(4); // a comprovada do cenário + as 3 extras do time B
    expect(pb.kpi.toquesHoje).toBe(4);
    expect(pb.canal.find((c) => c.canal === "call")!.count).toBe(4);

    const listaA = (await emTime(A, () => listaDoDia())).filter((i) => i.kind === "lead_sem_toque").map((i) => i.id);
    const listaB = (await emTime(B, () => listaDoDia())).filter((i) => i.kind === "lead_sem_toque").map((i) => i.id);
    expect(listaA.some((id) => Object.values(cb).includes(id))).toBe(false);
    expect(listaB.some((id) => Object.values(ca).includes(id))).toBe(false);
    // No B o "semNada" levou 3 ligações comprovadas e também saiu da lista.
    expect(listaB).not.toContain(cb.semNada);
    expect(listaA).toContain(ca.semNada);
  });
});
