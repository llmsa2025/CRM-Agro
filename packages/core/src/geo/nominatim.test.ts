import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { redisEstado } from "../shared/redis-cache";
import {
  NominatimGeocodificador,
  reservarVezNominatim,
  contarChamadaDoDia,
  CHAVE_VEZ_NOMINATIM,
  NOMINATIM_PUBLICO,
} from "./nominatim";
import { GeocodificadorIndisponivel } from "./geocodificador";

/**
 * Nominatim (produto §B.2): política de uso do público — 1 req/s para a
 * plataforma inteira (vez global no Redis, provada com relógio controlado),
 * User-Agent com contato, countrycodes=br. O HTTP é SEMPRE falso: nenhum teste
 * chama o serviço real.
 */

const DIA_TESTE = new Date("2031-02-03T10:00:00Z");
const chaveDia = `${CHAVE_VEZ_NOMINATIM}:dia:2031-02-03`;
// O teste da fila cheia passa pelo contador de HOJE (caminho padrão).
const chaveHoje = `${CHAVE_VEZ_NOMINATIM}:dia:${new Date().toISOString().slice(0, 10)}`;

beforeAll(async () => {
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
beforeEach(async () => {
  await redisEstado().del(CHAVE_VEZ_NOMINATIM, chaveDia);
});
afterAll(async () => {
  await redisEstado().del(CHAVE_VEZ_NOMINATIM, chaveDia, chaveHoje);
});

type Resposta = { status: number; body?: unknown };
function nominatimFalso(resposta: Resposta | (() => Resposta)) {
  const chamadas: { url: URL; headers: Record<string, string>; temSinal: boolean }[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: new URL(String(url)), headers: (init?.headers ?? {}) as Record<string, string>, temSinal: init?.signal instanceof AbortSignal });
    const r = typeof resposta === "function" ? resposta() : resposta;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchImpl: f as unknown as typeof fetch, chamadas };
}

describe("vez global — no máximo 1 requisição/s para a plataforma inteira", () => {
  it("5 pedidos no mesmo instante saem espaçados de 1 s", async () => {
    const t0 = 1_000_000;
    const esperas = await Promise.all([1, 2, 3, 4, 5].map(() => reservarVezNominatim(t0)));
    expect([...esperas].sort((a, b) => a - b)).toEqual([0, 1000, 2000, 3000, 4000]);
    // Depois que a fila anda, a vez volta a ser imediata.
    expect(await reservarVezNominatim(t0 + 10_000)).toBe(0);
  });

  it("pedidos em horários quaisquer nunca ficam a menos de 1 s um do outro", async () => {
    let agora = 5_000_000;
    const horarios: number[] = [];
    for (let i = 0; i < 25; i++) {
      agora += Math.floor(Math.random() * 1500); // de 0 a 1,5 s entre pedidos
      horarios.push(agora + (await reservarVezNominatim(agora)));
    }
    for (let i = 1; i < horarios.length; i++) expect(horarios[i]! - horarios[i - 1]!).toBeGreaterThanOrEqual(1000);
  });

  it("teto diário: passou dele, o provedor fica indisponível até o dia seguinte", async () => {
    expect(await contarChamadaDoDia(DIA_TESTE, 2)).toBe(true);
    expect(await contarChamadaDoDia(DIA_TESTE, 2)).toBe(true);
    expect(await contarChamadaDoDia(DIA_TESTE, 2)).toBe(false);
  });

  it("fila cheia (vez a mais de 20 s): não chama e avisa indisponível", async () => {
    await redisEstado().set(CHAVE_VEZ_NOMINATIM, String(Date.now() + 60_000), "PX", 60_000);
    const { fetchImpl, chamadas } = nominatimFalso({ status: 200, body: [] });
    const g = new NominatimGeocodificador({ contato: "contato@teste.example", fetchImpl });
    await expect(g.buscar("Sorriso, MT, Brasil")).rejects.toBeInstanceOf(GeocodificadorIndisponivel);
    expect(chamadas).toHaveLength(0);
  });
});

describe("NominatimGeocodificador — requisição e resposta", () => {
  const semEspera = vi.fn(async () => {});

  it("countrycodes=br, jsonv2, User-Agent com contato, teto de tempo e 1 vez por busca", async () => {
    const { fetchImpl, chamadas } = nominatimFalso({ status: 200, body: [{ lat: "-12.54", lon: "-55.72", place_rank: 30 }] });
    const g = new NominatimGeocodificador({ contato: "contato@teste.example", fetchImpl, aguardarVez: semEspera });
    expect(await g.buscar("Rua A, 1, Sorriso, MT, Brasil")).toEqual({ latitude: -12.54, longitude: -55.72, precisao: "endereco" });
    const c = chamadas[0]!;
    expect(c.url.origin + c.url.pathname).toBe(`${NOMINATIM_PUBLICO}/search`);
    expect(c.url.searchParams.get("countrycodes")).toBe("br");
    expect(c.url.searchParams.get("format")).toBe("jsonv2");
    expect(c.url.searchParams.get("q")).toBe("Rua A, 1, Sorriso, MT, Brasil");
    expect(c.headers["user-agent"]).toBe("CRM Agro/1.0 (contato@teste.example)");
    expect(c.temSinal).toBe(true);
    expect(semEspera).toHaveBeenCalledTimes(1);
  });

  it("público sem contato configurado: não chama (a política exige contato)", async () => {
    const { fetchImpl, chamadas } = nominatimFalso({ status: 200, body: [] });
    const vez = vi.fn(async () => {});
    const g = new NominatimGeocodificador({ contato: null, fetchImpl, aguardarVez: vez });
    await expect(g.buscar("Sorriso")).rejects.toThrow(/GEO_CONTATO/);
    expect(chamadas).toHaveLength(0);
    expect(vez).not.toHaveBeenCalled();
  });

  it("instância própria (NOMINATIM_URL) funciona sem contato", async () => {
    const { fetchImpl, chamadas } = nominatimFalso({ status: 200, body: [] });
    const g = new NominatimGeocodificador({ url: "http://nominatim.interno:8080/", contato: null, fetchImpl, aguardarVez: semEspera });
    expect(await g.buscar("Sorriso")).toBeNull();
    expect(chamadas[0]!.url.origin).toBe("http://nominatim.interno:8080");
    expect(chamadas[0]!.headers["user-agent"]).toBe("CRM Agro/1.0 (instancia-propria)");
  });

  it("precisão pelo place_rank; estado/país não serve; nada achado = null", async () => {
    const buscar = async (body: unknown) =>
      new NominatimGeocodificador({ contato: "c@t.example", fetchImpl: nominatimFalso({ status: 200, body }).fetchImpl, aguardarVez: semEspera }).buscar("x");
    expect(await buscar([{ lat: "-12.5", lon: "-55.7", place_rank: 16 }])).toMatchObject({ precisao: "cidade" });
    expect(await buscar([{ lat: "-12.5", lon: "-55.7", place_rank: 8 }])).toBeNull();
    expect(await buscar([])).toBeNull();
  });

  it("429/5xx/rede = indisponível (tenta depois); 400 = consulta inválida, conta como não achou", async () => {
    const com = (r: Resposta) => new NominatimGeocodificador({ contato: "c@t.example", fetchImpl: nominatimFalso(r).fetchImpl, aguardarVez: semEspera });
    await expect(com({ status: 429 }).buscar("x")).rejects.toBeInstanceOf(GeocodificadorIndisponivel);
    await expect(com({ status: 503 }).buscar("x")).rejects.toBeInstanceOf(GeocodificadorIndisponivel);
    await expect(com({ status: 200, body: { erro: "formato estranho" } }).buscar("x")).rejects.toBeInstanceOf(GeocodificadorIndisponivel);
    expect(await com({ status: 400 }).buscar("x")).toBeNull();
    const semRede = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new NominatimGeocodificador({ contato: "c@t.example", fetchImpl: semRede, aguardarVez: semEspera }).buscar("x")).rejects.toThrow(
      /erro de rede/,
    );
  });
});

describe("reverso — cidade/UF de um ponto", () => {
  it("lê town/city e a UF do ISO3166-2", async () => {
    const { fetchImpl, chamadas } = nominatimFalso({ status: 200, body: { address: { town: "Sorriso", state: "Mato Grosso", "ISO3166-2-lvl4": "BR-MT" } } });
    const g = new NominatimGeocodificador({ contato: "contato@teste.example", fetchImpl });
    expect(await g.reverso({ latitude: -12.55, longitude: -55.72 })).toEqual({ cidade: "Sorriso", estado: "MT" });
    expect(chamadas[0]!.url.pathname).toBe("/reverse");
    expect(chamadas[0]!.url.searchParams.get("zoom")).toBe("10");
    expect(chamadas[0]!.headers["user-agent"]).toContain("contato@teste.example");
  });
  it("sem ISO usa o nome do estado; sem município → null", async () => {
    const g1 = new NominatimGeocodificador({ contato: "c@x.example", fetchImpl: nominatimFalso({ status: 200, body: { address: { city: "Cuiabá", state: "Mato Grosso" } } }).fetchImpl });
    expect(await g1.reverso({ latitude: -15.6, longitude: -56.1 })).toEqual({ cidade: "Cuiabá", estado: "MT" });
    const g2 = new NominatimGeocodificador({ contato: "c@x.example", fetchImpl: nominatimFalso({ status: 404, body: { error: "Unable to geocode" } }).fetchImpl });
    expect(await g2.reverso({ latitude: 0, longitude: -30 })).toBeNull();
  });
  it("Nominatim público sem GEO_CONTATO → indisponível (política)", async () => {
    const g = new NominatimGeocodificador({ contato: null, fetchImpl: nominatimFalso({ status: 200, body: {} }).fetchImpl });
    await expect(g.reverso({ latitude: -12.55, longitude: -55.72 })).rejects.toBeInstanceOf(GeocodificadorIndisponivel);
  });
});
