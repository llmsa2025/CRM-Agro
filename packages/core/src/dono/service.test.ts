import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam, runVendoComo } from "@crmagro/db";
import {
  transferirContatos,
  transferirNegocios,
  transferirCanal,
  definirCompartilhado,
  listarPessoasDoTime,
  DestinoDaTransferenciaInvalido,
  SoODonoCompartilha,
} from "./service";
import { list } from "../contacts/service";
import { listConversations } from "../conversations/service";
import { ForbiddenError } from "../auth/authz";
import { OwnedNotFound } from "../tenancy/assert-owned";

/**
 * Transferir dono e compartilhar (F3d/F4): o admin redistribui a base (que o
 * backfill deu ao master) e o dono abre ou fecha um registro para o time.
 */
const TEAM = "00000000-0000-0000-0000-00000000f3d1";
const OUTRO = "00000000-0000-0000-0000-00000000f3d2";
const sufixo = Math.random().toString(36).slice(2, 7);
let master: { id: string }, admin: { id: string }, a: { id: string }, b: { id: string }, saiu: { id: string }, alheio: { id: string };
let c1 = "", c2 = "", compartilhadoComB = "", negocioDoMaster = "", negocioDoB = "", conta = "";

const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: u.id, role });

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Dono (test)"], [OUTRO, "Outro (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const mk = (n: string, role: string, teamId = TEAM, extra: Record<string, unknown> = {}) =>
    basePrisma.user.create({ data: { teamId, name: n, email: `${n}-${sufixo}@dono.dev`, role, ...extra } });
  master = await mk("master", "owner");
  admin = await mk("admin", "admin");
  a = await mk("a", "member");
  b = await mk("b", "member");
  saiu = await mk("saiu", "member", TEAM, { desativadoEm: new Date() });
  alheio = await mk("alheio", "owner", OUTRO);
  const contato = (nome: string, dono: { id: string }, compartilhado = false) =>
    basePrisma.contact.create({ data: { teamId: TEAM, nome, ownerId: dono.id, compartilhado } });
  c1 = (await contato("Base 1", master)).id;
  c2 = (await contato("Base 2", master)).id;
  compartilhadoComB = (await contato("Do time", master, true)).id;
  const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
  const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Novo", ordem: 0 } });
  const deal = (contactId: string, dono: { id: string }) =>
    basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId, ownerId: dono.id } });
  negocioDoMaster = (await deal(compartilhadoComB, master)).id;
  negocioDoB = (await deal(compartilhadoComB, b)).id;
  conta = (await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label: "Número do A", provider: "evolution", ownerId: master.id } })).id;
  await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", channelAccountId: conta, externalNumber: "+5565900000001", externalName: "Cliente" } });
});

afterAll(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    for (const m of ["conversation", "channelAccount", "deal", "stage", "funnel", "contact", "user"] as const) {
      await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId } });
    }
  }
});

describe("transferir dono", () => {
  it("só o administrador transfere; destino tem de ser pessoa ATIVA do time", async () => {
    await expect(como(a, "member", () => transferirContatos([c1], a.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(admin, "admin", () => transferirContatos([c1], saiu.id))).rejects.toBeInstanceOf(DestinoDaTransferenciaInvalido);
    await expect(como(admin, "admin", () => transferirContatos([c1], alheio.id))).rejects.toBeInstanceOf(DestinoDaTransferenciaInvalido);
    await expect(como(admin, "admin", () => transferirContatos([{ in: [c1] }] as unknown as string[], a.id))).rejects.toBeInstanceOf(OwnedNotFound);
  });

  it("contatos vão para o vendedor, com os negócios do mesmo dono; o negócio de um colega fica com ele", async () => {
    expect(await como(a, "member", () => list()).then((r) => r.items.map((c) => c.nome).sort())).toEqual(["Do time"]);
    const r = await como(admin, "admin", () => transferirContatos([c1, c2, compartilhadoComB], a.id));
    expect(r).toEqual({ contatos: 3, negocios: 1 });
    expect(await como(a, "member", () => list()).then((x) => x.items.map((c) => c.nome).sort())).toEqual(["Base 1", "Base 2", "Do time"]);
    expect((await basePrisma.deal.findUniqueOrThrow({ where: { id: negocioDoMaster } })).ownerId).toBe(a.id);
    expect((await basePrisma.deal.findUniqueOrThrow({ where: { id: negocioDoB } })).ownerId).toBe(b.id);
  });

  it("em lotes: 'todos do filtro' acima do lote transfere tudo e soma os totais", async () => {
    const r = await como(admin, "admin", () => transferirContatos([c1, c2, compartilhadoComB], b.id, { lote: 2 }));
    expect(r.contatos).toBe(3);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM, ownerId: b.id } })).toBe(3);
    // Volta tudo para o A (o resto dos testes conta com isso).
    await como(admin, "admin", () => transferirContatos([c1, c2, compartilhadoComB], a.id, { lote: 2 }));
  });

  it("negócio avulso e número: o vendedor passa a ver a conversa do número que recebeu", async () => {
    await como(admin, "admin", () => transferirNegocios([negocioDoB], a.id));
    expect((await basePrisma.deal.findUniqueOrThrow({ where: { id: negocioDoB } })).ownerId).toBe(a.id);
    expect((await como(a, "member", () => listConversations(conta))).items).toHaveLength(0);
    await como(master, "owner", () => transferirCanal(conta, a.id));
    expect((await como(a, "member", () => listConversations(conta))).items).toHaveLength(1);
  });
});

describe("compartilhar com o time", () => {
  it("o dono compartilha; o colega vê mas não fecha; o admin fecha", async () => {
    expect(await como(b, "member", () => list()).then((r) => r.items.map((c) => c.nome))).not.toContain("Base 1");
    await como(a, "member", () => definirCompartilhado("contact", c1, true));
    expect(await como(b, "member", () => list()).then((r) => r.items.map((c) => c.nome))).toContain("Base 1");
    await expect(como(b, "member", () => definirCompartilhado("contact", c1, false))).rejects.toBeInstanceOf(SoODonoCompartilha);
    await como(admin, "admin", () => definirCompartilhado("contact", c1, false));
    expect(await como(b, "member", () => list()).then((r) => r.items.map((c) => c.nome))).not.toContain("Base 1");
    // Quem não vê o registro nem chega a saber que existe.
    await expect(como(b, "member", () => definirCompartilhado("contact", c2, true))).rejects.toBeInstanceOf(OwnedNotFound);
  });
});

describe("pessoas do time e 'por vendedor'", () => {
  it("quem vê tudo lista a equipe (ativos primeiro); o vendedor só a si", async () => {
    const equipe = await como(admin, "admin", () => listarPessoasDoTime("contatos"));
    expect(equipe.map((p) => p.nome)).toEqual(["a", "admin", "b", "master", "saiu"]);
    expect(equipe.find((p) => p.nome === "saiu")?.ativo).toBe(false);
    expect((await como(a, "member", () => listarPessoasDoTime("contatos"))).map((p) => p.id)).toEqual([a.id]);
  });

  it("o admin lê como um vendedor (só estreita); o vendedor não amplia pedindo 'ver como'", async () => {
    const doA = await como(admin, "admin", () => runVendoComo(a.id, () => list()));
    expect(doA.items.map((c) => c.nome).sort()).toEqual(["Base 1", "Base 2", "Do time"]);
    const bComoMaster = await como(b, "member", () => runVendoComo(master.id, () => list()));
    expect(bComoMaster.items.map((c) => c.nome)).toEqual(["Do time"]);
  });
});
