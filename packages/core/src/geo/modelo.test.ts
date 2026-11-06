import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, db, nomeBuscaLugar } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Modelo do Mapa (produto §B.1): coordenada no Contact (por time), cache global
 * de geocodificação e centroides dos municípios (referência pública, sem
 * teamId). Municípios de teste com código IBGE fora da faixa real (99004xx).
 */
const TEAM = "00000000-0000-0000-0000-0000000004a7";
const OUTRO = "00000000-0000-0000-0000-0000000004a8";
const CODIGOS = [9900401, 9900402, 9900403];
const CHAVE_CACHE = "rua de teste do mapa 1|cidade teste mapa|zz";

async function limpar() {
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  await basePrisma.municipio.deleteMany({ where: { codigoIbge: { in: CODIGOS } } });
  await basePrisma.geoCache.deleteMany({ where: { chave: CHAVE_CACHE } });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Mapa A (test)"], [OUTRO, "Team Mapa B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
});

afterAll(limpar);

describe("nomeBuscaLugar — a mesma chave no seed e na busca", () => {
  it("sem acento, minúsculo, pontuação vira espaço", () => {
    expect(nomeBuscaLugar("Olho d'Água")).toBe("olho d agua");
    expect(nomeBuscaLugar("  São   Paulo ")).toBe("sao paulo");
    expect(nomeBuscaLugar("Embu-Guaçu")).toBe("embu guacu");
    expect(nomeBuscaLugar("SORRISO")).toBe(nomeBuscaLugar("sorriso"));
    expect(nomeBuscaLugar(null)).toBe("");
  });
});

describe("Municipio e GeoCache — referência global, sem teamId", () => {
  it("município: chave de busca única por UF", async () => {
    await basePrisma.municipio.create({
      data: { codigoIbge: CODIGOS[0]!, nome: "Cidade Teste Mapa", nomeBusca: nomeBuscaLugar("Cidade Teste Mapa"), uf: "ZZ", latitude: -12.5, longitude: -55.7 },
    });
    // Mesmo nome em outra UF: pode.
    await basePrisma.municipio.create({
      data: { codigoIbge: CODIGOS[1]!, nome: "Cidade Teste Mapa", nomeBusca: nomeBuscaLugar("Cidade Teste Mapa"), uf: "ZY", latitude: -1, longitude: -1 },
    });
    // Mesmo nome na mesma UF (escrito diferente): não pode.
    await expect(
      basePrisma.municipio.create({
        data: { codigoIbge: CODIGOS[2]!, nome: "Cidade teste mapa", nomeBusca: nomeBuscaLugar("Cidade teste mapa"), uf: "ZZ", latitude: 0, longitude: 0 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const achado = await basePrisma.municipio.findUnique({
      where: { uf_nomeBusca: { uf: "ZZ", nomeBusca: nomeBuscaLugar("cidade TESTE mapa") } },
    });
    expect(achado).toMatchObject({ codigoIbge: CODIGOS[0], latitude: -12.5, longitude: -55.7 });
  });

  it("cache de geocodificação guarda também o 'não achou' (coordenada nula)", async () => {
    await basePrisma.geoCache.create({ data: { chave: CHAVE_CACHE, precisao: "nenhuma", fonte: "nominatim" } });
    expect(await basePrisma.geoCache.findUnique({ where: { chave: CHAVE_CACHE } })).toMatchObject({
      latitude: null,
      longitude: null,
      precisao: "nenhuma",
    });
  });
});

describe("Coordenada do contato — por time", () => {
  it("grava e lê pelo db() do time; o outro time não vê", async () => {
    await runWithTeam(TEAM, () =>
      db().contact.create({
        data: {
          teamId: TEAM,
          nome: "Produtor com coordenada",
          cidade: "Sorriso",
          estado: "MT",
          latitude: -12.5425,
          longitude: -55.7211,
          geoPrecisao: "cidade",
          geoFonte: "ibge",
          geoHash: "x",
          geoAtualizadoEm: new Date(),
          culturas: ["soja", "milho"],
        },
      }),
    );
    const doTime = await runWithTeam(TEAM, () => db().contact.findMany({ where: { latitude: { not: null } } }));
    expect(doTime).toHaveLength(1);
    expect(doTime[0]).toMatchObject({ geoPrecisao: "cidade", culturas: ["soja", "milho"] });
    expect(await runWithTeam(OUTRO, () => db().contact.findMany({ where: { latitude: { not: null } } }))).toHaveLength(0);
  });
});
