import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, db, runWithTeam, TenantContextRequiredError, TenantMismatchError } from "@crmagro/db";
import { findDuplicateContacts } from "../contacts/service";
import { contatosPerto } from "../geo/mapa";

/**
 * Auditoria de isolamento 09/2026 — a extensão de tenancy e o SQL cru.
 * Relatório: a documentação interna (achado S-12 e mapa
 * de cobertura §§1–2).
 *
 * Padrão "dois times" (A e B) + "dois usuários do mesmo time" (a e b no time A).
 * Nada é enviado: só leitura e escrita no banco de TESTE.
 */
const TEAM_A = "00000000-0000-0000-0000-00000005ec0a";
const TEAM_B = "00000000-0000-0000-0000-00000005ec0b";
const sufixo = Math.random().toString(36).slice(2, 7);
let master: { id: string }, a: { id: string }, b: { id: string }, donoB: { id: string };
let perto1 = "", perto2 = "", pertoDoB = "", pertoOutroTime = "";

const como = <T>(teamId: string, u: { id: string }, role: string, fn: () => Promise<T>) => runWithTeam(teamId, fn, { userId: u.id, role });

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  await limpar();
  for (const [id, name] of [
    [TEAM_A, "Seg extensão A (test)"],
    [TEAM_B, "Seg extensão B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const mk = (teamId: string, n: string, role: string) =>
    basePrisma.user.create({ data: { teamId, name: n, email: `seg-ext-${n}-${sufixo}@teste.crmagro`, role } });
  master = await mk(TEAM_A, "master", "owner");
  a = await mk(TEAM_A, "a", "member");
  b = await mk(TEAM_A, "b", "member");
  donoB = await mk(TEAM_B, "donob", "owner");

  // Duplicados pelo NOME: dois do vendedor a, um do b e dois no outro time.
  const dup = (teamId: string, ownerId: string) => basePrisma.contact.create({ data: { teamId, nome: `Duplicado ${sufixo}`, ownerId } });
  await dup(TEAM_A, a.id);
  await dup(TEAM_A, a.id);
  await dup(TEAM_A, b.id);
  await dup(TEAM_B, donoB.id);
  await dup(TEAM_B, donoB.id);

  // "Perto daqui": todos no mesmo ponto (Sorriso/MT).
  const ponto = { latitude: -12.55, longitude: -55.71 };
  const perto = (teamId: string, nome: string, ownerId: string) =>
    basePrisma.contact.create({ data: { teamId, nome: `${nome} ${sufixo}`, ownerId, ...ponto } });
  perto1 = (await perto(TEAM_A, "Perto 1", a.id)).id;
  perto2 = (await perto(TEAM_A, "Perto 2", a.id)).id;
  pertoDoB = (await perto(TEAM_A, "Perto do b", b.id)).id;
  pertoOutroTime = (await perto(TEAM_B, "Perto do outro time", donoB.id)).id;
});

afterAll(limpar);

describe("extensão de tenancy — fail-closed", () => {
  it("db() sem time no contexto lança (nunca devolve 'todos')", () => {
    expect(() => db()).toThrow(TenantContextRequiredError);
  });
});

describe("extensão de tenancy — atualização não troca o time do registro (S-12, corrigido)", () => {
  it("update/updateMany/updateManyAndReturn/upsert com outro teamId (ou team.connect) são recusados", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: `Mover ${sufixo}`, ownerId: master.id } });
    await runWithTeam(TEAM_A, async () => {
      const p = db();
      // `as never`: o tipo do Prisma aceita teamId no update; a extensão é quem barra.
      await expect(p.contact.update({ where: { id: c.id }, data: { teamId: TEAM_B } as never })).rejects.toBeInstanceOf(TenantMismatchError);
      await expect(p.contact.updateMany({ where: { id: c.id }, data: { teamId: TEAM_B } as never })).rejects.toBeInstanceOf(TenantMismatchError);
      await expect(p.contact.updateManyAndReturn({ where: { id: c.id }, data: { teamId: TEAM_B } as never })).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
      await expect(
        p.contact.upsert({ where: { id: c.id }, update: { teamId: TEAM_B } as never, create: { nome: "x" } as never }),
      ).rejects.toBeInstanceOf(TenantMismatchError);
      await expect(
        p.contact.update({ where: { id: c.id }, data: { team: { connect: { id: TEAM_B } } } as never }),
      ).rejects.toBeInstanceOf(TenantMismatchError);
      // O mesmo time do contexto continua aceito (nenhum serviço quebra).
      await p.contact.update({ where: { id: c.id }, data: { nome: `Mover ok ${sufixo}`, teamId: TEAM_A } as never });
    });
    const depois = await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(depois.teamId).toBe(TEAM_A);
    expect(depois.nome).toBe(`Mover ok ${sufixo}`);
    await basePrisma.contact.delete({ where: { id: c.id } });
  });
});

describe("SQL cru ($queryRaw) — teamId explícito e escopo por dono", () => {
  it("duplicados: o time só vê os seus; o vendedor só os do escopo dele", async () => {
    const dosGrupos = async (teamId: string, u: { id: string }, role: string) =>
      (await como(teamId, u, role, () => findDuplicateContacts()))
        .filter((g) => g.contacts.some((c) => c.nome === `Duplicado ${sufixo}`))
        .map((g) => g.contacts.map((c) => c.id).sort());
    const idsDoTime = async (teamId: string) =>
      (await basePrisma.contact.findMany({ where: { teamId, nome: `Duplicado ${sufixo}` }, select: { id: true } })).map((c) => c.id).sort();

    // Master do time A: um grupo com os 3 do time A (nenhum id do time B).
    expect(await dosGrupos(TEAM_A, master, "owner")).toEqual([await idsDoTime(TEAM_A)]);
    // Vendedor a: só os dois dele; o do b não entra.
    const doA = (await basePrisma.contact.findMany({ where: { teamId: TEAM_A, nome: `Duplicado ${sufixo}`, ownerId: a.id }, select: { id: true } }))
      .map((c) => c.id)
      .sort();
    expect(await dosGrupos(TEAM_A, a, "member")).toEqual([doA]);
    // Vendedor b: um contato só → nenhum grupo.
    expect(await dosGrupos(TEAM_A, b, "member")).toEqual([]);
    // Time B: só os dele.
    expect(await dosGrupos(TEAM_B, donoB, "owner")).toEqual([await idsDoTime(TEAM_B)]);
  });

  it("'perto daqui' (Haversine no SQL): nem o contato do colega nem o de outro time", async () => {
    const ids = async (u: { id: string }, role: string) => (await como(TEAM_A, u, role, () => contatosPerto({ contactId: perto1, km: 50 }))).map((c) => c.id);
    const doA = await ids(a, "member");
    expect(doA).toContain(perto2);
    expect(doA).not.toContain(pertoDoB);
    expect(doA).not.toContain(pertoOutroTime);
    const doMaster = await ids(master, "owner");
    expect(doMaster).toEqual(expect.arrayContaining([perto2, pertoDoB]));
    expect(doMaster).not.toContain(pertoOutroTime);
    // O ponto de partida do colega não abre para o vendedor b (não é do escopo dele).
    await expect(como(TEAM_A, b, "member", () => contatosPerto({ contactId: perto1, km: 50 }))).rejects.toMatchObject({ name: "ContactNotFound" });
  });
});
