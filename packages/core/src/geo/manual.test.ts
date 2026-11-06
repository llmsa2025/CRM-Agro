import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { GeocodificadorIndisponivel } from "./geocodificador";
import type { NominatimGeocodificador } from "./nominatim";
import { cidadeDoPonto, definirLocalizacaoManual, ContatoNaoLocalizavel, HASH_MANUAL } from "./manual";

/** Pino manual (criar contato pelo mapa): grava no contato do time e nunca no de outro. */
const TEAM_A = "00000000-0000-0000-0000-0000000000e1";
const TEAM_B = "00000000-0000-0000-0000-0000000000e2";

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (pino manual)"],
    [TEAM_B, "Team B (pino manual)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(async () => {
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
});

describe("definirLocalizacaoManual", () => {
  it("grava lat/lng como manual no contato do próprio time", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Produtor A", cidade: "Sorriso", estado: "MT" } });
    await runWithTeam(TEAM_A, () => definirLocalizacaoManual(c.id, { latitude: -12.55, longitude: -55.72 }));
    const depois = await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(depois.latitude).toBeCloseTo(-12.55);
    expect(depois.longitude).toBeCloseTo(-55.72);
    expect(depois.geoPrecisao).toBe("manual");
    expect(depois.geoFonte).toBe("manual");
    expect(depois.geoHash).toBe(HASH_MANUAL);
    expect(depois.geoAtualizadoEm).not.toBeNull();
  });

  it("o time B não move o contato do time A", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Produtor A" } });
    await expect(runWithTeam(TEAM_B, () => definirLocalizacaoManual(c.id, { latitude: -1, longitude: -1 }))).rejects.toBeInstanceOf(ContatoNaoLocalizavel);
    const depois = await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(depois.latitude).toBeNull();
  });

  it("recusa coordenada fora do mundo", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Produtor A" } });
    await expect(runWithTeam(TEAM_A, () => definirLocalizacaoManual(c.id, { latitude: 95, longitude: 0 }))).rejects.toThrow();
  });
});

describe("cidadeDoPonto — melhor esforço", () => {
  it("devolve cidade/UF do provedor", async () => {
    const falso = { reverso: async () => ({ cidade: "Sorriso", estado: "MT" }) } as unknown as NominatimGeocodificador;
    expect(await cidadeDoPonto({ latitude: -12.55, longitude: -55.72 }, falso)).toEqual({ cidade: "Sorriso", estado: "MT" });
  });
  it("provedor indisponível (sem GEO_CONTATO, sem rede) → null, sem quebrar", async () => {
    const falso = {
      reverso: async () => {
        throw new GeocodificadorIndisponivel("GEO_CONTATO não configurado");
      },
    } as unknown as NominatimGeocodificador;
    expect(await cidadeDoPonto({ latitude: -12.55, longitude: -55.72 }, falso)).toBeNull();
  });
});
