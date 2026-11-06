import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  basePrisma,
  db,
  runWithTeam,
  TENANT_MODELS,
  TENANT_KNOWN_OPERATIONS,
} from "@crmagro/db";
import { createInvite, listInvites, revokeInvite } from "../auth/invites";

/**
 * Regressão da extensão de tenancy (auditoria S2 e S3 — item 0.2 do plano).
 *
 * 1. DMMF: todo model com coluna `teamId` precisa estar em TENANT_MODELS. Foi
 *    assim que `Invite` escapou — nada cobrava a lista contra o schema.
 * 2. Dois times: cada operação do Prisma, rodando no time A, nunca lê nem altera
 *    linha do time B. Inclui as que passavam sem filtro (`findUniqueOrThrow`,
 *    `findFirstOrThrow`, `updateManyAndReturn`).
 * 3. Convite volta a funcionar e é por time.
 */

const TEAM_A = "00000000-0000-0000-0000-0000000000e5";
const TEAM_B = "00000000-0000-0000-0000-0000000000f6";

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (tenancy test)"],
    [TEAM_B, "Team B (tenancy test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  await basePrisma.invite.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
});

describe("TENANT_MODELS × schema (DMMF)", () => {
  it("todo model com coluna teamId está na extensão de tenancy", () => {
    const comTeamId = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === "teamId"))
      .map((m) => m.name);
    const faltando = comTeamId.filter((nome) => !TENANT_MODELS.has(nome));
    expect(faltando).toEqual([]);
  });

  it("todo nome em TENANT_MODELS existe no schema e tem teamId", () => {
    const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
    const invalidos = [...TENANT_MODELS].filter(
      (nome) => !models.get(nome)?.fields.some((f) => f.name === "teamId"),
    );
    expect(invalidos).toEqual([]);
  });

  it("a extensão conhece as operações que antes passavam sem filtro", () => {
    for (const op of ["findUniqueOrThrow", "findFirstOrThrow", "updateManyAndReturn"]) {
      expect(TENANT_KNOWN_OPERATIONS.has(op)).toBe(true);
    }
  });
});

describe("dois times — nenhuma operação cruza a fronteira", () => {
  async function criarPar() {
    const a = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Contato A" } });
    const b = await basePrisma.contact.create({ data: { teamId: TEAM_B, nome: "Contato B" } });
    return { a, b };
  }

  it("leituras no time A não enxergam o time B", async () => {
    const { a, b } = await criarPar();
    await runWithTeam(TEAM_A, async () => {
      const p = db();
      expect(await p.contact.findUnique({ where: { id: b.id } })).toBeNull();
      expect(await p.contact.findFirst({ where: { id: b.id } })).toBeNull();
      await expect(p.contact.findUniqueOrThrow({ where: { id: b.id } })).rejects.toThrow();
      await expect(p.contact.findFirstOrThrow({ where: { id: b.id } })).rejects.toThrow();
      expect((await p.contact.findMany()).map((c) => c.id)).toEqual([a.id]);
      expect(await p.contact.count()).toBe(1);
      const agg = await p.contact.aggregate({ _count: { _all: true } });
      expect(agg._count._all).toBe(1);
      const grupos = await p.contact.groupBy({ by: ["teamId"], _count: { _all: true } });
      expect(grupos).toEqual([{ teamId: TEAM_A, _count: { _all: 1 } }]);
    });
  });

  it("escritas no time A não alteram nem apagam o time B", async () => {
    const { b } = await criarPar();
    await runWithTeam(TEAM_A, async () => {
      const p = db();
      await expect(p.contact.update({ where: { id: b.id }, data: { nome: "invadido" } })).rejects.toThrow();
      expect((await p.contact.updateMany({ where: { id: b.id }, data: { nome: "invadido" } })).count).toBe(0);
      expect(await p.contact.updateManyAndReturn({ where: { id: b.id }, data: { nome: "invadido" } })).toEqual([]);
      await expect(p.contact.delete({ where: { id: b.id } })).rejects.toThrow();
      expect((await p.contact.deleteMany({ where: { id: b.id } })).count).toBe(0);
      // upsert com id do outro time: não acha no time A → cria NOVO no time A,
      // sem tocar no registro do time B.
      await p.contact.upsert({
        where: { id: b.id },
        update: { nome: "invadido" },
        // teamId vem da extensão; o tipo do Prisma exige no create, daí o cast.
        create: { nome: "Criado pelo upsert" } as never,
      });
    });
    const intacto = await basePrisma.contact.findUniqueOrThrow({ where: { id: b.id } });
    expect(intacto.nome).toBe("Contato B");
    expect(intacto.teamId).toBe(TEAM_B);
  });

  it("criações recebem o teamId do contexto (ignoram o que vier no dado)", async () => {
    await runWithTeam(TEAM_A, async () => {
      const p = db();
      const c = await p.contact.create({ data: { nome: "Novo", teamId: TEAM_B } as never });
      expect(c.teamId).toBe(TEAM_A);
      const lote = await p.contact.createManyAndReturn({ data: [{ nome: "L1" }, { nome: "L2" }] as never });
      expect(lote.every((x) => x.teamId === TEAM_A)).toBe(true);
    });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_B } })).toBe(0);
  });
});

describe("convites — emissão volta a funcionar e é por time", () => {
  // O ator do RBAC exige userId + papel (fail-closed). userId fictício basta: o
  // serviço só o usa para autorizar, não grava FK com ele aqui.
  // Master (owner): desde a F2a, administrador só convida com a permissão
  // "convidar" liberada pelo master (coberta em auth/equipe.test.ts).
  const ADMIN_A = { userId: "admin-a", role: "owner" };
  const ADMIN_B = { userId: "admin-b", role: "owner" };

  it("admin do time A emite, lista e revoga só no próprio time", async () => {
    const convA = await runWithTeam(TEAM_A, () => createInvite({ email: "novo.a@exemplo.com.br" }), ADMIN_A);
    await runWithTeam(TEAM_B, () => createInvite({ email: "novo.b@exemplo.com.br" }), ADMIN_B);

    const listaA = await runWithTeam(TEAM_A, () => listInvites(), ADMIN_A);
    expect(listaA.map((i) => i.email)).toEqual(["novo.a@exemplo.com.br"]);

    // Time B tenta revogar o convite do time A: nada acontece.
    await runWithTeam(TEAM_B, () => revokeInvite(convA.id), ADMIN_B);
    const aindaAtivo = await basePrisma.invite.findUniqueOrThrow({ where: { id: convA.id } });
    expect(aindaAtivo.revokedAt).toBeNull();

    // O próprio time revoga.
    await runWithTeam(TEAM_A, () => revokeInvite(convA.id), ADMIN_A);
    const revogado = await basePrisma.invite.findUniqueOrThrow({ where: { id: convA.id } });
    expect(revogado.revokedAt).not.toBeNull();
  });

  it("convite ACEITO sai da lista de convites (já é integrante); revogado fica para o histórico", async () => {
    const aceito = await runWithTeam(TEAM_A, () => createInvite({ email: "aceito.a@exemplo.com.br" }), ADMIN_A);
    const pendente = await runWithTeam(TEAM_A, () => createInvite({ email: "pendente.a@exemplo.com.br" }), ADMIN_A);
    const revogado = await runWithTeam(TEAM_A, () => createInvite({ email: "revogado.a@exemplo.com.br" }), ADMIN_A);
    await basePrisma.invite.update({ where: { id: aceito.id }, data: { acceptedAt: new Date() } });
    await runWithTeam(TEAM_A, () => revokeInvite(revogado.id), ADMIN_A);

    const lista = await runWithTeam(TEAM_A, () => listInvites(), ADMIN_A);
    const ids = lista.map((i) => i.id);
    expect(ids).not.toContain(aceito.id);
    expect(ids).toContain(pendente.id);
    expect(ids).toContain(revogado.id);
  });
});
