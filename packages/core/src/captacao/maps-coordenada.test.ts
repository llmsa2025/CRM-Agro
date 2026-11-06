import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Contato importado da captação do Google Maps nasce com a coordenada da ficha
 * (produto §B): sem esperar o backfill nem gastar Nominatim.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: vi.fn(),
  getFlowQueue: () => ({}),
}));
const { insertDrafts, importDrafts } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000000e3";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: { name: "Team (maps coordenada)" }, create: { id: TEAM, name: "Team (maps coordenada)" } });
});
beforeEach(async () => {
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
});

describe("importDrafts — Maps", () => {
  it("grava lat/lng da ficha no contato (fonte maps, precisão endereço)", async () => {
    await runWithTeam(TEAM, () =>
      insertDrafts("maps", "lote-1", [
        { nome: "Fazenda Boa Vista", empresa: "Fazenda Boa Vista", telefone: "+5566999120001", cidade: "Sorriso", uf: "MT", extra: { endereco: "Rod. BR-163, km 12 - Sorriso - MT", lat: -12.5412, lng: -55.7211 } },
      ]),
    );
    const draft = await basePrisma.prospectDraft.findFirstOrThrow({ where: { teamId: TEAM } });
    const r = await runWithTeam(TEAM, () => importDrafts([draft.id]));
    expect(r.importados).toBe(1);
    const c = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM, nome: "Fazenda Boa Vista" } });
    expect(c.latitude).toBeCloseTo(-12.5412);
    expect(c.longitude).toBeCloseTo(-55.7211);
    expect(c.geoPrecisao).toBe("endereco");
    expect(c.geoFonte).toBe("maps");
    expect(c.geoHash).not.toBeNull();
    expect(c.endereco).toContain("BR-163");
  });

  it("ficha sem coordenada fica para o backfill (lat/lng nulos, geoHash nulo)", async () => {
    await runWithTeam(TEAM, () => insertDrafts("maps", "lote-2", [{ nome: "Sem Pino", telefone: "+5566999120002", cidade: "Sinop", uf: "MT", extra: { endereco: null, lat: null, lng: null } }]));
    const draft = await basePrisma.prospectDraft.findFirstOrThrow({ where: { teamId: TEAM } });
    await runWithTeam(TEAM, () => importDrafts([draft.id]));
    const c = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM, nome: "Sem Pino" } });
    expect(c.latitude).toBeNull();
    expect(c.geoHash).toBeNull();
  });
});
