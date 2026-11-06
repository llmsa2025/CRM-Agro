import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { list, getById, count } from "../contacts/service";
import { ContactNotFound } from "../contacts/errors";
import { getFunnelBoard } from "../funnels/board";
import { listDealsByContact, getFunnel, deleteDeal, listFunnelsWithStats } from "../funnels/service";
import { kpis } from "../dashboard/service";
import { contatoNoMapa } from "../geo/camadas";
import { unlinkCompany } from "../companies/service";
import { pontosDoMapa, filtrosDaQuery } from "../geo/mapa";
import { assertOwned, OwnedNotFound } from "./assert-owned";
import { redisCache } from "../shared/redis-cache";

/**
 * Escopo por dono (F3b), "dois usuários do mesmo time": o vendedor A não vê
 * nem escreve nos contatos/negócios do vendedor B; o compartilhado aparece para
 * todos; master e "ver tudo" veem tudo; o filtro "por vendedor" restringe.
 */
const TEAM = "00000000-0000-0000-0000-00000000f3b1";
const sufixo = Math.random().toString(36).slice(2, 7);
let master: { id: string }, a: { id: string }, b: { id: string };
let doA: { id: string }, doB: { id: string }, comum: { id: string }, funilId = "", negocioDoB = "";

const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>, extra: { verTudoEm?: string[] } = {}) =>
  runWithTeam(TEAM, fn, { userId: u.id, role, ...extra });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Escopo leituras (test)" } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n}-${sufixo}@escopo.dev`, role } });
  master = await mk("master", "owner");
  a = await mk("a", "member");
  b = await mk("b", "member");
  const ponto = { latitude: -12.5, longitude: -55.7 };
  doA = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do A", ownerId: a.id, ...ponto } });
  doB = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do B", ownerId: b.id, ...ponto } });
  comum = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do time", ownerId: master.id, compartilhado: true, ...ponto } });
  const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
  funilId = funil.id;
  const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Novo", ordem: 0 } });
  for (const [c, dono] of [
    [doA, a],
    [doB, b],
  ] as const) {
    const d = await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId: c.id, ownerId: dono.id, valor: 100 } });
    if (dono === b) negocioDoB = d.id;
  }
  const painel = await redisCache().keys(`dash:${TEAM}:*`).catch(() => [] as string[]);
  if (painel.length) await redisCache().del(...painel);
  const chaves = await redisCache().keys(`mapa:${TEAM}:*`).catch(() => [] as string[]);
  if (chaves.length) await redisCache().del(...chaves);
});
afterAll(async () => {
  for (const m of ["deal", "stage", "funnel", "contact", "user"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  }
});

const nomes = (r: { items: { nome: string }[] }) => r.items.map((c) => c.nome).sort();

describe("escopo por dono — dois usuários do mesmo time", () => {
  it("contatos: A vê os seus e o compartilhado; não vê os do B nem pela ficha", async () => {
    expect(nomes(await como(a, "member", () => list()))).toEqual(["Lead do A", "Lead do time"]);
    expect(await como(a, "member", () => count())).toBe(2);
    await expect(como(a, "member", () => getById(doB.id))).rejects.toBeInstanceOf(ContactNotFound);
    await expect(como(a, "member", () => getById(comum.id))).resolves.toMatchObject({ nome: "Lead do time" });
  });

  it("master e 'ver tudo' veem todos; o filtro 'por vendedor' restringe", async () => {
    expect(nomes(await como(master, "owner", () => list()))).toEqual(["Lead do A", "Lead do B", "Lead do time"]);
    expect(nomes(await como(a, "member", () => list(), { verTudoEm: ["contatos"] }))).toEqual(["Lead do A", "Lead do B", "Lead do time"]);
    expect(nomes(await como(master, "owner", () => list({ dono: b.id })))).toEqual(["Lead do B"]);
  });

  it("funil: o kanban de A só tem os negócios dele; o master vê todos e filtra por vendedor", async () => {
    const cards = (board: Awaited<ReturnType<typeof getFunnelBoard>>) => board.stages.flatMap((s) => s.deals.map((c) => c.contact.nome)).sort();
    expect(cards(await como(a, "member", () => getFunnelBoard(funilId)))).toEqual(["Lead do A"]);
    expect(cards(await como(master, "owner", () => getFunnelBoard(funilId)))).toEqual(["Lead do A", "Lead do B"]);
    expect(cards(await como(master, "owner", () => getFunnelBoard(funilId, { dono: b.id })))).toEqual(["Lead do B"]);
    expect(await como(a, "member", () => listDealsByContact(doB.id))).toEqual([]);
  });

  it("mapa: os pontos de A não trazem os do B (e o cache não mistura)", async () => {
    const pts = async (u: { id: string }, role: string) => {
      const r = await como(u, role, () => pontosDoMapa(filtrosDaQuery(new URLSearchParams(""))));
      return r.tipo === "pontos" ? [...r.nome].sort() : [];
    };
    expect(await pts(master, "owner")).toEqual(["Lead do A", "Lead do B", "Lead do time"]);
    expect(await pts(a, "member")).toEqual(["Lead do A", "Lead do time"]);
    expect(await pts(b, "member")).toEqual(["Lead do B", "Lead do time"]);
  });

  it("escrita com id do contato de outro vendedor é recusada (assertOwned com escopo)", async () => {
    await expect(como(a, "member", () => assertOwned("contact", doB.id))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(a, "member", () => assertOwned("contact", comum.id))).resolves.toBeUndefined();
    await expect(como(master, "owner", () => assertOwned("contact", doB.id))).resolves.toBeUndefined();
  });

  it("funil completo e totais do funil: só os negócios do escopo", async () => {
    const nomesNoFunil = async (u: { id: string }, role: string) =>
      (await como(u, role, () => getFunnel(funilId))).stages.flatMap((s) => s.deals.map((d) => d.contact.nome)).sort();
    expect(await nomesNoFunil(a, "member")).toEqual(["Lead do A"]);
    expect(await nomesNoFunil(master, "owner")).toEqual(["Lead do A", "Lead do B"]);
    const abertos = async (u: { id: string }, role: string) =>
      (await como(u, role, () => listFunnelsWithStats())).flatMap((f) => f.stages.flatMap((s) => s.deals)).length;
    expect(await abertos(a, "member")).toBe(1);
    expect(await abertos(master, "owner")).toBe(2);
  });

  it("painel pelo caminho do membro: contagens e negócios só dele (cache separado do master)", async () => {
    const k = async (u: { id: string }, role: string) => {
      const r = await como(u, role, () => kpis());
      return { contatos: r.totalContatos, negocios: r.negociosAtivos.count };
    };
    expect(await k(master, "owner")).toEqual({ contatos: 3, negocios: 2 });
    expect(await k(a, "member")).toEqual({ contatos: 2, negocios: 1 });
    expect(await k(b, "viewer")).toEqual({ contatos: 2, negocios: 1 });
  });

  it("por id: excluir negócio, desvincular empresa e o cartão do mapa recusam o registro do colega", async () => {
    await expect(como(a, "member", () => deleteDeal(negocioDoB))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await basePrisma.deal.count({ where: { id: negocioDoB } })).toBe(1);
    await expect(como(a, "member", () => unlinkCompany(doB.id, "00000000-0000-0000-0000-000000000000"))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await como(a, "member", () => contatoNoMapa(doB.id))).toBeNull();
    expect(await como(a, "member", () => contatoNoMapa(doA.id))).toMatchObject({ id: doA.id });
  });
});
