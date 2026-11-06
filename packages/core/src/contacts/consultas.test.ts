import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma, db } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { listOrigens, findDuplicateContacts, importCsv, DUP_CONTATOS_POR_GRUPO, DUP_MAX_GRUPOS } from "./service";
import { listTags, tagFilterSummary } from "../tags/service";
import { listFlows } from "../flows/service";
import { getFunnel } from "../funnels/service";
import { getFunnelBoard, listFunnelDeals, CARDS_POR_ETAPA } from "../funnels/board";
import { FunnelNotFound, StageNotFound } from "../funnels/errors";
import { CursorInvalido } from "../shared/cursor-keyset";

/**
 * Item 2.4 (DP-10, DP-11, DP-12, DP-17): as consultas de Contatos/Tags/Fluxos/
 * Kanban/Duplicados mudaram de forma (groupBy, count no banco, SQL), não de
 * resultado. Cada teste compara com a implementação ANTIGA (copiada aqui) sobre
 * o mesmo dado e confere que o time B nunca aparece para o A.
 */

const TEAM_A = "00000000-0000-0000-0000-0000000001a3";
const TEAM_B = "00000000-0000-0000-0000-0000000001a4";
const TIMES = [TEAM_A, TEAM_B];

async function limpar() {
  const where = { teamId: { in: TIMES } };
  await basePrisma.deal.deleteMany({ where });
  await basePrisma.stage.deleteMany({ where });
  await basePrisma.funnel.deleteMany({ where });
  await basePrisma.enrollment.deleteMany({ where });
  await basePrisma.flow.deleteMany({ where });
  await basePrisma.contactTag.deleteMany({ where });
  await basePrisma.tag.deleteMany({ where });
  await basePrisma.channelIdentifier.deleteMany({ where });
  await basePrisma.contact.deleteMany({ where });
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Time A (agente A — consultas 2.4)"],
    [TEAM_B, "Time B (agente A — consultas 2.4)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(limpar);
afterAll(limpar);

/** Contatos com createdAt crescente (1 s de distância) — ordem determinística. */
let relogio = Date.UTC(2026, 0, 1);
async function criarContatos(
  teamId: string,
  linhas: { nome: string; origem?: string | null; tel?: string; email?: string }[],
): Promise<string[]> {
  const rows = linhas.map((l) => ({ id: randomUUID(), teamId, nome: l.nome, origem: l.origem ?? null, createdAt: new Date((relogio += 1000)) }));
  await basePrisma.contact.createMany({ data: rows });
  const idents = linhas.flatMap((l, i) => [
    ...(l.tel ? [{ teamId, contactId: rows[i]!.id, canal: "whatsapp" as const, valor: l.tel, isPrimary: true }] : []),
    ...(l.email ? [{ teamId, contactId: rows[i]!.id, canal: "email" as const, valor: l.email, isPrimary: true }] : []),
  ]);
  if (idents.length) await basePrisma.channelIdentifier.createMany({ data: idents });
  return rows.map((r) => r.id);
}

// ────────────────────────────────────────────────────────────────────────────
// Implementações ANTIGAS (referência de equivalência).
// ────────────────────────────────────────────────────────────────────────────

async function antigoListOrigens() {
  const rows = await db().contact.findMany({
    where: { origem: { not: null } },
    select: { origem: true },
    distinct: ["origem"],
    orderBy: { origem: "asc" },
  });
  return rows.map((r) => r.origem as string);
}

async function antigoListTags() {
  const rows = await db().tag.findMany({
    orderBy: { nome: "asc" },
    include: { _count: { select: { contactTags: true } } },
  });
  return rows.map((t) => ({ id: t.id, nome: t.nome, cor: t.cor, count: t._count.contactTags }));
}

async function antigoTagFilterSummary() {
  const prisma = db();
  const [total, comTag, tags] = await Promise.all([
    prisma.contact.count(),
    prisma.contactTag.findMany({ distinct: ["contactId"], select: { contactId: true } }),
    antigoListTags(),
  ]);
  return { total, semTag: Math.max(0, total - comTag.length), tags };
}

/**
 * Mesma consulta antiga, com a ÚNICA diferença desejada: o DTO de fluxo nunca expõe o segredo do webhook.
 * `webhookToken`, `webhookTokenHash`, `webhookTokenGeradoEm` e `triggerConfig.webhookToken` saem; entram `webhookTem` e `webhookGeradoEm`
 * (só o fato de haver URL e quando foi gerada). Montado à mão aqui, de propósito, sem chamar o código de produção.
 */
async function antigoListFlows() {
  const linhas = await db().flow.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { _count: { select: { enrollments: true } } },
    take: 51,
  });
  return linhas.map(({ webhookToken, webhookTokenHash, webhookTokenGeradoEm, ...resto }) => ({
    ...resto,
    // O espelho do texto puro dentro do triggerConfig também sai.
    triggerConfig: resto.triggerConfig && typeof resto.triggerConfig === "object" && !Array.isArray(resto.triggerConfig)
      ? Object.fromEntries(Object.entries(resto.triggerConfig).filter(([k]) => k !== "webhookToken"))
      : resto.triggerConfig,
    webhookTem: Boolean(webhookToken || webhookTokenHash),
    webhookGeradoEm: webhookTokenGeradoEm ?? null,
  }));
}

async function antigoFindDuplicates() {
  const contacts = await db().contact.findMany({ include: { identifiers: true }, orderBy: { createdAt: "asc" } });
  const info = contacts.map((c) => ({
    c,
    tel: c.identifiers.find((i) => i.canal === "whatsapp")?.valor ?? null,
    email: c.identifiers.find((i) => i.canal === "email")?.valor ?? null,
  }));
  const byId = new Map(info.map((x) => [x.c.id, x]));
  const byName = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, key: string | null | undefined, id: string) => {
    if (!key) return;
    const a = m.get(key) ?? [];
    a.push(id);
    m.set(key, a);
  };
  for (const { c, tel, email } of info) {
    push(byName, c.nome.trim().toLowerCase().replace(/\s+/g, " "), c.id);
    if (tel) push(byPhone, tel.replace(/\D/g, "").slice(-8), c.id);
    if (email) push(byEmail, email.trim().toLowerCase(), c.id);
  }
  const groups = new Map<string, { reasons: Set<string>; ids: string[] }>();
  const addGroup = (reason: string, ids: string[]) => {
    if (ids.length < 2) return;
    const key = [...ids].sort().join(",");
    const g = groups.get(key) ?? { reasons: new Set<string>(), ids: [...ids].sort() };
    g.reasons.add(reason);
    groups.set(key, g);
  };
  for (const ids of byName.values()) addGroup("nome", ids);
  for (const ids of byPhone.values()) addGroup("telefone", ids);
  for (const ids of byEmail.values()) addGroup("email", ids);
  const label: Record<string, string> = { nome: "Nome igual", telefone: "Telefone igual", email: "E-mail igual" };
  return [...groups.values()]
    .map((g) => ({
      reasons: [...g.reasons].map((r) => label[r] ?? r),
      contacts: g.ids.map((id) => {
        const x = byId.get(id)!;
        return {
          id,
          nome: x.c.nome,
          telefone: x.tel,
          email: x.email,
          empresa: x.c.empresa,
          cidade: x.c.cidade,
          createdAt: x.c.createdAt.toISOString(),
        };
      }),
    }))
    .sort((a, b) => b.contacts.length - a.contacts.length);
}

// ────────────────────────────────────────────────────────────────────────────

describe("listOrigens (DP-10) — groupBy no banco", () => {
  it("mesmas origens, ordenadas, sem nulo; só do próprio time", async () => {
    await criarContatos(TEAM_A, [
      { nome: "a1", origem: "maps" },
      { nome: "a2", origem: "cnpj" },
      { nome: "a3", origem: "maps" },
      { nome: "a4", origem: null },
      { nome: "a5", origem: "Planilha" },
    ]);
    await criarContatos(TEAM_B, [{ nome: "b1", origem: "instagram" }]);

    await runWithTeam(TEAM_A, async () => {
      const novo = await listOrigens();
      expect(novo).toEqual(await antigoListOrigens());
      expect(novo).toHaveLength(3);
      expect(novo).not.toContain("instagram");
    });
    await runWithTeam(TEAM_B, async () => expect(await listOrigens()).toEqual(["instagram"]));
  });
});

describe("listTags / tagFilterSummary (DP-10, DP-11)", () => {
  it("contagem por tag e 'sem tag' iguais ao código antigo; dois times não se misturam", async () => {
    const idsA = await criarContatos(TEAM_A, [{ nome: "a1" }, { nome: "a2" }, { nome: "a3" }, { nome: "a4" }, { nome: "a5" }]);
    const idsB = await criarContatos(TEAM_B, [{ nome: "b1" }, { nome: "b2" }, { nome: "b3" }]);
    const [quente, frio, vazia] = [randomUUID(), randomUUID(), randomUUID()];
    const quenteB = randomUUID();
    await basePrisma.tag.createMany({
      data: [
        { id: quente, teamId: TEAM_A, nome: "Quente" },
        { id: frio, teamId: TEAM_A, nome: "Frio", cor: "blue" },
        { id: vazia, teamId: TEAM_A, nome: "Vazia" },
        // Mesmo nome no time B: a contagem não pode somar as duas.
        { id: quenteB, teamId: TEAM_B, nome: "Quente" },
      ],
    });
    await basePrisma.contactTag.createMany({
      data: [
        { teamId: TEAM_A, contactId: idsA[0]!, tagId: quente },
        { teamId: TEAM_A, contactId: idsA[1]!, tagId: quente },
        { teamId: TEAM_A, contactId: idsA[2]!, tagId: frio },
        { teamId: TEAM_B, contactId: idsB[0]!, tagId: quenteB },
        { teamId: TEAM_B, contactId: idsB[1]!, tagId: quenteB },
        { teamId: TEAM_B, contactId: idsB[2]!, tagId: quenteB },
      ],
    });

    await runWithTeam(TEAM_A, async () => {
      const tags = await listTags();
      expect(tags).toEqual(await antigoListTags());
      expect(tags.map((t) => [t.nome, t.count])).toEqual([
        ["Frio", 1],
        ["Quente", 2],
        ["Vazia", 0],
      ]);
      const resumo = await tagFilterSummary();
      expect(resumo).toEqual(await antigoTagFilterSummary());
      expect(resumo.total).toBe(5);
      expect(resumo.semTag).toBe(2);
    });
    await runWithTeam(TEAM_B, async () => {
      const resumo = await tagFilterSummary();
      expect(resumo).toEqual(await antigoTagFilterSummary());
      expect(resumo).toMatchObject({ total: 3, semTag: 0 });
      expect(resumo.tags).toEqual([{ id: quenteB, nome: "Quente", cor: null, count: 3 }]);
    });
  });
});

describe("listFlows (DP-11) — contagem por groupBy", () => {
  it("mesmo DTO (_count.enrollments) do include antigo; inscrições do time B não contam", async () => {
    const contatosA = await criarContatos(TEAM_A, [{ nome: "c1" }, { nome: "c2" }, { nome: "c3" }]);
    const contatosB = await criarContatos(TEAM_B, [{ nome: "d1" }, { nome: "d2" }]);
    const [f1, f2, fB] = [randomUUID(), randomUUID(), randomUUID()];
    await basePrisma.flow.createMany({
      data: [
        // Fluxo com segredo de webhook gravado (texto puro legado + hash + espelho no triggerConfig): nada disso pode sair no DTO.
        {
          id: f1, teamId: TEAM_A, nome: "Com 3", triggerType: "webhook", createdAt: new Date(Date.UTC(2026, 0, 1)),
          webhookToken: `tok-${f1}`, webhookTokenHash: `hash-${f1}`, webhookTokenGeradoEm: new Date(Date.UTC(2026, 0, 1)),
          triggerConfig: { webhookToken: `tok-${f1}`, jitterMin: 1 },
        },
        { id: f2, teamId: TEAM_A, nome: "Sem inscrição", triggerType: "manual", createdAt: new Date(Date.UTC(2026, 0, 2)) },
        { id: fB, teamId: TEAM_B, nome: "Do B", triggerType: "manual" },
      ],
    });
    await basePrisma.enrollment.createMany({
      data: [
        ...contatosA.map((c) => ({ teamId: TEAM_A, flowId: f1, contactId: c, currentNodeId: "n1", status: "done" as const })),
        ...contatosB.map((c) => ({ teamId: TEAM_B, flowId: fB, contactId: c, currentNodeId: "n1", status: "done" as const })),
      ],
    });

    await runWithTeam(TEAM_A, async () => {
      const { items, hasMore, nextCursor } = await listFlows();
      const antigo = await antigoListFlows();
      expect(items).toEqual(antigo);
      // O DTO nunca carrega o token nem o hash do webhook (nem o espelho dentro do triggerConfig).
      for (const f of items) {
        expect(Object.keys(f)).not.toContain("webhookToken");
        expect(Object.keys(f)).not.toContain("webhookTokenHash");
        expect(Object.keys(f)).not.toContain("webhookTokenGeradoEm");
        expect(JSON.stringify(f)).not.toMatch(/webhookToken/);
      }
      expect(hasMore).toBe(false);
      expect(nextCursor).toBeNull();
      expect(items.map((f) => [f.nome, f._count.enrollments])).toEqual([
        ["Sem inscrição", 0],
        ["Com 3", 3],
      ]);
    });
    await runWithTeam(TEAM_B, async () => {
      const { items } = await listFlows();
      expect(items.map((f) => [f.id, f._count.enrollments])).toEqual([[fB, 2]]);
    });
  });
});

describe("Kanban paginado (DP-12)", () => {
  async function montarFunil(teamId: string, abertosEtapa1: number) {
    const funnelId = randomUUID();
    const [e1, e2] = [randomUUID(), randomUUID()];
    await basePrisma.funnel.create({ data: { id: funnelId, teamId, nome: "Vendas", tipo: "vendas" } });
    await basePrisma.stage.createMany({
      data: [
        { id: e1, teamId, funnelId, nome: "Novo", ordem: 0 },
        { id: e2, teamId, funnelId, nome: "Proposta", ordem: 1 },
      ],
    });
    const contatos = await criarContatos(
      teamId,
      Array.from({ length: abertosEtapa1 + 6 }, (_, i) => ({ nome: `Lead ${i}` })),
    );
    // Json pesado no contato: não pode vazar para o cartão.
    await basePrisma.contact.updateMany({ where: { id: { in: contatos } }, data: { enrichment: { resumo: "x".repeat(500) }, empresa: "Fazenda" } });
    const base = Date.UTC(2026, 5, 1);
    const deals = [
      // Metade com o MESMO enteredStageAt: o desempate por id tem de segurar o cursor.
      ...Array.from({ length: abertosEtapa1 }, (_, i) => ({
        teamId, funnelId, stageId: e1, contactId: contatos[i]!, valor: 10, status: "open" as const,
        enteredStageAt: new Date(i % 2 ? base : base + i * 60_000),
      })),
      { teamId, funnelId, stageId: e1, contactId: contatos[abertosEtapa1]!, valor: 100, status: "won" as const },
      { teamId, funnelId, stageId: e2, contactId: contatos[abertosEtapa1 + 1]!, valor: 50, status: "won" as const },
      { teamId, funnelId, stageId: e2, contactId: contatos[abertosEtapa1 + 2]!, valor: 7, status: "lost" as const },
      ...[3, 4, 5].map((k) => ({
        teamId, funnelId, stageId: e2, contactId: contatos[abertosEtapa1 + k]!, valor: 1, status: "open" as const,
      })),
    ];
    await basePrisma.deal.createMany({ data: deals });
    return { funnelId, e1, e2 };
  }

  it("50 abertos por etapa + contagem real; carregar mais percorre o resto sem repetir nem pular", async () => {
    const { funnelId, e1, e2 } = await montarFunil(TEAM_A, 61);
    await montarFunil(TEAM_B, 5);

    await runWithTeam(TEAM_A, async () => {
      const board = await getFunnelBoard(funnelId);
      const [s1, s2] = board.stages;
      expect([s1!.id, s2!.id]).toEqual([e1, e2]);
      expect(s1!.deals).toHaveLength(CARDS_POR_ETAPA);
      expect(s1!.total).toBe(61);
      expect(s1!.valor).toBe(610);
      expect(s1!.nextCursor).not.toBeNull();
      expect(s2!.deals).toHaveLength(3);
      expect(s2!.total).toBe(3);
      expect(s2!.nextCursor).toBeNull();
      expect(board.fechados).toEqual({ won: { total: 2, valor: 150 }, lost: { total: 1, valor: 7 } });
      // Só os campos do cartão; nada de enrichment.
      expect(Object.keys(s1!.deals[0]!.contact).sort()).toEqual(["empresa", "id", "nome"]);
      expect(s1!.deals.every((d) => d.status === "open")).toBe(true);

      // Carregar mais em páginas de 4 (força vários cursores com data empatada).
      const vistos = s1!.deals.map((d) => d.id);
      let cursor = s1!.nextCursor;
      while (cursor) {
        const pg = await listFunnelDeals(funnelId, { stageId: e1, cursor, limit: 4 });
        vistos.push(...pg.items.map((d) => d.id));
        cursor = pg.nextCursor;
      }
      expect(new Set(vistos).size).toBe(61);
      expect(vistos).toHaveLength(61);

      // Equivalência com o getFunnel antigo: mesmos deals abertos por etapa.
      const legado = await getFunnel(funnelId);
      const abertosLegado = legado.stages[0]!.deals.filter((d) => d.status === "open").map((d) => d.id);
      expect([...vistos].sort()).toEqual([...abertosLegado].sort());
      // O legado segue com TODOS os status (a tela atual depende disso) e contato enxuto.
      expect(legado.stages.flatMap((s) => s.deals)).toHaveLength(61 + 6);
      expect(Object.keys(legado.stages[0]!.deals[0]!.contact).sort()).toEqual(["empresa", "id", "nome"]);

      // Coluna recolhida: ganhos do funil inteiro.
      const ganhos = await listFunnelDeals(funnelId, { status: "won" });
      expect(ganhos.items.map((d) => d.valor).sort()).toEqual(["100", "50"]);
    });
  });

  it("dois times: funil/etapa de outro time não abre; cursor adulterado é recusado", async () => {
    const a = await montarFunil(TEAM_A, 2);
    const b = await montarFunil(TEAM_B, 2);
    await runWithTeam(TEAM_B, async () => {
      await expect(getFunnelBoard(a.funnelId)).rejects.toBeInstanceOf(FunnelNotFound);
      await expect(listFunnelDeals(a.funnelId, { stageId: a.e1 })).rejects.toBeInstanceOf(FunnelNotFound);
      // Etapa do time A dentro do funil do B: também não.
      await expect(listFunnelDeals(b.funnelId, { stageId: a.e1 })).rejects.toBeInstanceOf(StageNotFound);
      await expect(listFunnelDeals(b.funnelId, { stageId: b.e1, cursor: "lixo" })).rejects.toBeInstanceOf(CursorInvalido);
      const board = await getFunnelBoard(b.funnelId);
      expect(board.stages[0]!.total).toBe(2);
    });
  });
});

describe("findDuplicateContacts (DP-17) — SQL por time", () => {
  it("mesmos grupos, motivos e ordem do código antigo; nada do time B", async () => {
    await criarContatos(TEAM_A, [
      { nome: "  Ana   Silva ", tel: "+5565999998888", email: "ana@x.com" },
      { nome: "ana silva", tel: "+556599998888" }, // sem o 9º dígito: mesmo final de 8
      { nome: "JOSÉ Souza", email: "jose@x.com" },
      { nome: "josé souza", email: "JOSE@X.COM" },
      { nome: "Pedro", tel: "+5511912345678" },
      { nome: "Paulo", tel: "+5521912345678" }, // outro DDD, mesmo final: telefone igual
      { nome: "Maria", email: "maria@x.com" },
      { nome: "   " }, // nome vazio não agrupa
      { nome: "\t" },
      { nome: "Único", tel: "+5565900000001" },
      // NBSP (colado de planilha/site): o `\s` do JS pegava; o SQL também tem de pegar.
      { nome: "Carla\u00a0Dias" },
      { nome: "carla dias\u2003" },
    ]);
    // Mesmo nome e telefone no time B: não pode entrar em grupo do A.
    await criarContatos(TEAM_B, [
      { nome: "Ana Silva", tel: "+5565999998888" },
      { nome: "Pedro", tel: "+5511912345678" },
    ]);

    await runWithTeam(TEAM_A, async () => {
      const novo = await findDuplicateContacts();
      const antigo = await antigoFindDuplicates();
      expect(novo.map(({ total: _t, ...g }) => g)).toEqual(antigo);
      expect(novo.every((g) => g.total === g.contacts.length)).toBe(true);
      expect(novo.map((g) => g.reasons)).toEqual([
        ["Nome igual", "Telefone igual"],
        ["Nome igual", "E-mail igual"],
        ["Nome igual"],
        ["Telefone igual"],
      ]);
    });
    await runWithTeam(TEAM_B, async () => {
      expect(await findDuplicateContacts()).toEqual([]);
    });
  });

  it(`grupo gigante vem com total real e até ${DUP_CONTATOS_POR_GRUPO} contatos; no máximo ${DUP_MAX_GRUPOS} grupos`, async () => {
    await criarContatos(
      TEAM_A,
      Array.from({ length: DUP_CONTATOS_POR_GRUPO + 5 }, () => ({ nome: "Lead (webhook)" })),
    );
    // 200 pares com nomes distintos → 201 grupos no total; volta só 200.
    await criarContatos(
      TEAM_A,
      Array.from({ length: DUP_MAX_GRUPOS * 2 }, (_, i) => ({ nome: `Par ${Math.floor(i / 2)}` })),
    );
    await runWithTeam(TEAM_A, async () => {
      const grupos = await findDuplicateContacts();
      expect(grupos).toHaveLength(DUP_MAX_GRUPOS);
      expect(grupos[0]!.total).toBe(DUP_CONTATOS_POR_GRUPO + 5);
      expect(grupos[0]!.contacts).toHaveLength(DUP_CONTATOS_POR_GRUPO);
      // Os listados são os primeiros por id (mesma ordem do sort do JS).
      const ids = grupos[0]!.contacts.map((c) => c.id);
      expect(ids).toEqual([...ids].sort());
      expect(grupos.slice(1).every((g) => g.total === 2 && g.contacts.length === 2)).toBe(true);
    });
  });
});

describe("importCsv (DP-16) — duplicata checada em blocos de 1.000", () => {
  it("2.500 já existentes (3 blocos) são pulados; e-mail igual no time B não conta", async () => {
    const existentes = Array.from({ length: 2500 }, (_, i) => ({ nome: `Lote ${i}`, email: `lote${i}@x.com` }));
    await criarContatos(TEAM_A, existentes);
    await criarContatos(TEAM_B, [{ nome: "Do B", email: "novo1@x.com" }]);
    const csv = ["nome,email", ...existentes.map((e) => `${e.nome},${e.email}`), "Novo 1,novo1@x.com", "Novo 2,NOVO2@x.com"].join("\n");

    const r = await runWithTeam(TEAM_A, async () => importCsv(csv));
    expect(r).toMatchObject({ created: 2, skipped: 2500 });
    expect(r.errors).toEqual([]);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(2502);
  });
});
