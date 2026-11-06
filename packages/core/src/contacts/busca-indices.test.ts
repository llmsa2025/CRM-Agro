import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { list, count } from "./service";

/**
 * Item 2.1 (índices + trigram): a busca continua dando o MESMO resultado —
 * "contém" sem diferenciar maiúsculas, em nome, empresa e identificador, mais
 * novos primeiro — e nunca mistura times.
 */
const TEAM = "00000000-0000-0000-0000-0000000001a0";
const OUTRO = "00000000-0000-0000-0000-0000000001a1";

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Busca ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
  }
  const base = Date.now() - 60_000;
  const criar = (teamId: string, nome: string, empresa: string | null, i: number, fone?: string) =>
    basePrisma.contact.create({
      data: {
        teamId,
        nome,
        empresa,
        createdAt: new Date(base + i * 1000),
        ...(fone ? { identifiers: { create: { teamId, canal: "whatsapp", valor: fone, isPrimary: true } } } : {}),
      },
    });
  await criar(TEAM, "Ana Silva", "Fazenda Boa Vista", 1);
  await criar(TEAM, "Bruno Costa", "Agro SILVA Ltda", 2);
  await criar(TEAM, "Carla Souza", null, 3, "+5566999887766");
  await criar(TEAM, "Diego Lima", "Cerealista", 4);
  await criar(OUTRO, "Silva do Outro Time", "Silva Agro", 5, "+5566999887700");
});

describe("busca de contatos com índices trigram", () => {
  it("'silva' acha nome e empresa, sem diferenciar maiúsculas, mais novos primeiro, só do time", async () => {
    const r = await runWithTeam(TEAM, () => list({ search: "silva" }));
    expect(r.items.map((c) => c.nome)).toEqual(["Bruno Costa", "Ana Silva"]);
    expect(await runWithTeam(TEAM, () => count({ search: "silva" }))).toBe(2);
  });

  it("trecho do telefone acha pelo identificador; o do outro time não aparece", async () => {
    const r = await runWithTeam(TEAM, () => list({ search: "99988" }));
    expect(r.items.map((c) => c.nome)).toEqual(["Carla Souza"]);
  });

  it("dois times: o outro time só vê o próprio contato", async () => {
    const r = await runWithTeam(OUTRO, () => list({ search: "silva" }));
    expect(r.items.map((c) => c.nome)).toEqual(["Silva do Outro Time"]);
  });

  it("sem busca: paginação pela ordem (createdAt desc, id desc) do índice novo", async () => {
    const p1 = await runWithTeam(TEAM, () => list({ limit: 2 }));
    expect(p1.items.map((c) => c.nome)).toEqual(["Diego Lima", "Carla Souza"]);
    const p2 = await runWithTeam(TEAM, () => list({ limit: 2, cursor: p1.nextCursor ?? undefined }));
    expect(p2.items.map((c) => c.nome)).toEqual(["Bruno Costa", "Ana Silva"]);
  });
});
