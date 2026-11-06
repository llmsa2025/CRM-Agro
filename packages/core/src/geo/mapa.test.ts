import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ZodError } from "zod";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisCache } from "../shared/redis-cache";
import { pontosDoMapa, resumoDoMapa, contatosPerto, filtrosDaQuery, MAPA_MAX_PONTOS } from "./mapa";
import { rotaDoDia, ordenarPorVizinhoMaisProximo, linkGoogleMaps } from "./rota";

/**
 * Consulta do Mapa (produto §B.3): bbox e filtros, clusters acima de 5.000,
 * resumo que bate com a contagem, "perto de", rota do dia — e o teste "dois
 * times" em cada consulta (o SQL cru leva o teamId explícito). Coordenadas em
 * MT; o time B tem contatos NO MESMO bbox, que nunca aparecem para o A.
 */
const TEAM = "00000000-0000-0000-0000-0000000004ab";
const OUTRO = "00000000-0000-0000-0000-0000000004ac";
const BBOX_MT = "-58,-15,-54,-11"; // w,s,e,n

type Novo = { nome: string; lat: number; lng: number; st?: "novo" | "ja_conversou" | "cliente" | "opt_out"; culturas?: string[]; cidade?: string };
async function contato(teamId: string, c: Novo) {
  return basePrisma.contact.create({
    data: {
      teamId,
      nome: c.nome,
      latitude: c.lat,
      longitude: c.lng,
      relacionamentoStatus: c.st ?? "novo",
      culturas: c.culturas ?? [],
      cidade: c.cidade ?? "Sorriso",
      estado: "MT",
      geoPrecisao: "cidade",
    },
  });
}

async function limparCache() {
  for (const t of [TEAM, OUTRO]) {
    const chaves = await redisCache().keys(`mapa:${t}:*`);
    if (chaves.length) await redisCache().del(...chaves);
  }
}

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.appointment.deleteMany({ where: { teamId } });
    await basePrisma.campaignRecipient.deleteMany({ where: { teamId } });
    await basePrisma.campaign.deleteMany({ where: { teamId } });
    await basePrisma.deal.deleteMany({ where: { teamId } });
    await basePrisma.stage.deleteMany({ where: { teamId } });
    await basePrisma.funnel.deleteMany({ where: { teamId } });
    await basePrisma.activity.deleteMany({ where: { teamId } });
    await basePrisma.contactTag.deleteMany({ where: { teamId } });
    await basePrisma.tag.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.mapaCamada.deleteMany({ where: { teamId } });
  }
  await limparCache();
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Mapa Consulta A (test)"], [OUTRO, "Team Mapa Consulta B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisCache();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
beforeEach(limpar);
afterAll(limpar);

const pontos = (teamId: string, q: string) => runWithTeam(teamId, () => pontosDoMapa(filtrosDaQuery(new URLSearchParams(q))));

describe("pontosDoMapa", () => {
  it("bbox filtra; o outro time no MESMO bbox não aparece (dois times)", async () => {
    const dentro = await contato(TEAM, { nome: "Dentro", lat: -12.5, lng: -55.7 });
    await contato(TEAM, { nome: "Fora (Goiânia)", lat: -16.7, lng: -49.3 });
    await contato(OUTRO, { nome: "Do outro time", lat: -12.6, lng: -55.8 });
    await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Sem coordenada" } });
    const r = await pontos(TEAM, `bbox=${BBOX_MT}`);
    expect(r).toMatchObject({ tipo: "pontos", total: 1, ids: [dentro.id], nome: ["Dentro"], st: ["novo"], lat: [-12.5], lng: [-55.7] });
    const b = await pontos(OUTRO, `bbox=${BBOX_MT}`);
    expect(b).toMatchObject({ total: 1, nome: ["Do outro time"] });
  });

  it("filtros: status, cultura (sem caixa), tag e 'sem tag', negócio aberto/sem, campanha, interação recente", async () => {
    const soja = await contato(TEAM, { nome: "Soja cliente", lat: -12.5, lng: -55.7, st: "cliente", culturas: ["Soja", "milho"] });
    const algodao = await contato(TEAM, { nome: "Algodão novo", lat: -12.4, lng: -55.6, culturas: ["algodão"] });
    const tag = await basePrisma.tag.create({ data: { teamId: TEAM, nome: "Visitar" } });
    await basePrisma.contactTag.create({ data: { teamId: TEAM, contactId: algodao.id, tagId: tag.id } });
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
    const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Proposta", ordem: 1 } });
    await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId: soja.id, valor: 1500 } });
    const camp = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Safra" } });
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: camp.id, contactId: algodao.id } });
    await basePrisma.activity.create({ data: { teamId: TEAM, contactId: soja.id, tipo: "whatsapp", direcao: "in", conteudo: "oi" } });

    const nomes = async (q: string) => {
      const r = await pontos(TEAM, q);
      return r.tipo === "pontos" ? [...r.nome].sort() : [];
    };
    expect(await nomes("status=cliente")).toEqual(["Soja cliente"]);
    expect(await nomes("status=novo,ja_conversou")).toEqual(["Algodão novo"]);
    expect(await nomes("cultura=SOJA")).toEqual(["Soja cliente"]);
    expect(await nomes(`tag=${tag.id}`)).toEqual(["Algodão novo"]);
    expect(await nomes("tag=__none__")).toEqual(["Soja cliente"]);
    expect(await nomes("negocio=aberto")).toEqual(["Soja cliente"]);
    expect(await nomes("negocio=sem")).toEqual(["Algodão novo"]);
    expect(await nomes(`campanha=${camp.id}`)).toEqual(["Algodão novo"]);
    expect(await nomes("dias=7")).toEqual(["Soja cliente"]);
    // A tag, o negócio e a campanha do time A não valem para o B.
    expect(await pontos(OUTRO, `tag=${tag.id}`)).toMatchObject({ total: 0 });
  });

  it(`acima de ${MAPA_MAX_PONTOS} vira clusters por grade (contagem e status batem)`, async () => {
    const n = MAPA_MAX_PONTOS + 1;
    await basePrisma.contact.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        teamId: TEAM,
        nome: `Massa ${i}`,
        // duas células de 0,25°: metade perto de Sorriso, metade perto de Sinop
        latitude: i % 2 ? -12.55 + (i % 7) * 0.001 : -11.86 + (i % 7) * 0.001,
        longitude: i % 2 ? -55.72 : -55.51,
        relacionamentoStatus: i % 3 === 0 ? ("cliente" as const) : ("novo" as const),
      })),
    });
    const r = await pontos(TEAM, `bbox=${BBOX_MT}`);
    expect(r.tipo).toBe("clusters");
    if (r.tipo !== "clusters") return;
    expect(r.total).toBe(n);
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters.reduce((a, c) => a + c.n, 0)).toBe(n);
    const clientes = r.clusters.reduce((a, c) => a + (c.porStatus.cliente ?? 0), 0);
    expect(clientes).toBe(Math.ceil(n / 3));
    for (const c of r.clusters) expect(c.lat).toBeGreaterThan(-12.6);
    // Com filtro que reduz a menos de 5.000, volta a ser pontos.
    expect((await pontos(TEAM, `bbox=${BBOX_MT}&status=cliente`)).tipo).toBe("pontos");
  }, 60_000);

  it("cache de 60 s por time: o 2º pedido igual vem do cache; o outro time não herda o cache do A", async () => {
    await contato(TEAM, { nome: "Primeiro", lat: -12.5, lng: -55.7 });
    expect(await pontos(TEAM, "status=novo")).toMatchObject({ total: 1 });
    await contato(TEAM, { nome: "Depois do cache", lat: -12.5, lng: -55.7 });
    expect(await pontos(TEAM, "status=novo")).toMatchObject({ total: 1 });
    expect(await pontos(OUTRO, "status=novo")).toMatchObject({ total: 0 });
  });

  it("filtro inválido na query é recusado (zod); valor vazio é ignorado", () => {
    expect(() => filtrosDaQuery(new URLSearchParams("bbox=1,2,3"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("bbox=10,0,5,1"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("status=inexistente"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("campanha=1; drop table"))).toThrow(ZodError);
    expect(filtrosDaQuery(new URLSearchParams("status=&cultura=&dias=30"))).toEqual({ dias: 30 });
  });
});

describe("resumoDoMapa — bate com a contagem", () => {
  it("total, por status, responderam, clientes, negócios abertos, culturas e cidades; nada do outro time", async () => {
    const a = await contato(TEAM, { nome: "A", lat: -12.5, lng: -55.7, st: "cliente", culturas: ["soja", "milho"], cidade: "Sorriso" });
    const b = await contato(TEAM, { nome: "B", lat: -12.4, lng: -55.6, culturas: ["Soja"], cidade: "Sorriso" });
    await contato(TEAM, { nome: "C", lat: -11.8, lng: -55.5, st: "ja_conversou", cidade: "Sinop" });
    const outro = await contato(OUTRO, { nome: "X", lat: -12.5, lng: -55.7, st: "cliente", culturas: ["soja"] });
    await basePrisma.activity.create({ data: { teamId: TEAM, contactId: b.id, tipo: "whatsapp", direcao: "in" } });
    await basePrisma.activity.create({ data: { teamId: TEAM, contactId: a.id, tipo: "whatsapp", direcao: "out" } });
    await basePrisma.activity.create({ data: { teamId: OUTRO, contactId: outro.id, tipo: "whatsapp", direcao: "in" } });
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
    const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Proposta", ordem: 1 } });
    await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId: a.id, valor: 1000 } });
    await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId: b.id, valor: 250.5 } });
    await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId: b.id, valor: 99, status: "won" } });

    const r = await runWithTeam(TEAM, () => resumoDoMapa(filtrosDaQuery(new URLSearchParams(`bbox=${BBOX_MT}`))));
    const count = await basePrisma.contact.count({ where: { teamId: TEAM, latitude: { not: null } } });
    expect(r.total).toBe(count);
    expect(r).toMatchObject({
      total: 3,
      porStatus: { cliente: 1, novo: 1, ja_conversou: 1 },
      responderam: 1,
      clientes: 1,
      negociosAbertos: { n: 2, valor: 1250.5 },
    });
    expect(r.culturas).toEqual([
      { nome: "soja", pct: 66.7 },
      { nome: "milho", pct: 33.3 },
    ]);
    expect(r.cidades).toEqual([
      { nome: "Sorriso", uf: "MT", n: 2 },
      { nome: "Sinop", uf: "MT", n: 1 },
    ]);
  });
});

describe("resumoDoMapa — equivalência com um cálculo independente (ORM)", () => {
  /** Gerador pseudoaleatório com semente fixa: o mesmo conjunto a cada rodada. */
  function aleatorio(semente: number) {
    let x = semente;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  it("o resumo (5 consultas numa transação) dá o mesmo que o ORM calcula, em 3 combinações de filtro", async () => {
    const r = aleatorio(42);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const STATUS = ["novo", "ja_conversou", "cliente", "opt_out"] as const;
    const CULTURAS = ["soja", "milho", "algodao", "feijao", "sorgo", "cafe", "trigo", "arroz", "cana", "girassol", "gergelim", "amendoim"];
    // Nomes só com letras minúsculas: a ordem alfabética do Postgres e a do JS coincidem.
    const CIDADES = ["cidadea", "cidadeb", "cidadec", "cidaded", "cidadee", "cidadef", "cidadeg", "cidadeh", "cidadei", "cidadej", "cidadek", "cidadel"];
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
    const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Proposta", ordem: 1 } });
    const camadasDoTeste = await Promise.all(
      ["1.000 ha", "5.000 ha"].map(async (nome) => (await basePrisma.mapaCamada.create({ data: { teamId: TEAM, nome } })).id),
    );
    for (const teamId of [TEAM, OUTRO]) {
      for (let i = 0; i < 80; i++) {
        const lat = -15 + r() * 6; // metade dentro do bbox de teste, metade fora
        const c = await basePrisma.contact.create({
          data: {
            teamId,
            nome: `Eq ${i}`,
            latitude: lat,
            longitude: -58 + r() * 4,
            relacionamentoStatus: pick(STATUS),
            culturas: Array.from(new Set([pick(CULTURAS), ...(r() < 0.5 ? [pick(CULTURAS).toUpperCase()] : [])])),
            cidade: r() < 0.1 ? null : pick(CIDADES),
            estado: "MT",
            areaHa: r() < 0.5 ? Math.round(r() * 500000) / 100 : null,
            camadaId: teamId === TEAM && r() < 0.4 ? pick(camadasDoTeste) : null,
          },
        });
        if (r() < 0.3) await basePrisma.activity.create({ data: { teamId, contactId: c.id, tipo: "whatsapp", direcao: r() < 0.6 ? "in" : "out" } });
        if (teamId === TEAM && r() < 0.25) {
          await basePrisma.deal.create({
            data: { teamId, funnelId: funil.id, stageId: etapa.id, contactId: c.id, valor: Math.round(r() * 100000) / 100, status: r() < 0.8 ? "open" : "lost" },
          });
        }
      }
    }

    /** Oráculo: o mesmo resumo pelo ORM do Prisma, sem SQL cru. */
    async function oraculo(f: { bbox?: readonly [number, number, number, number]; status?: readonly string[] }) {
      const contatos = await basePrisma.contact.findMany({
        where: {
          teamId: TEAM,
          latitude: f.bbox ? { gte: f.bbox[1], lte: f.bbox[3] } : { not: null },
          longitude: f.bbox ? { gte: f.bbox[0], lte: f.bbox[2] } : { not: null },
          ...(f.status ? { relacionamentoStatus: { in: [...f.status] as (typeof STATUS)[number][] } } : {}),
        },
        select: { id: true, relacionamentoStatus: true, culturas: true, cidade: true, estado: true, camadaId: true, areaHa: true },
      });
      const ids = contatos.map((c) => c.id);
      const total = contatos.length;
      const porStatus: Record<string, number> = {};
      for (const c of contatos) porStatus[c.relacionamentoStatus] = (porStatus[c.relacionamentoStatus] ?? 0) + 1;
      const resp = await basePrisma.activity.findMany({ where: { teamId: TEAM, direcao: "in", contactId: { in: ids } }, distinct: ["contactId"], select: { contactId: true } });
      const deals = await basePrisma.deal.findMany({ where: { teamId: TEAM, status: "open", contactId: { in: ids } }, select: { valor: true } });
      const porCultura = new Map<string, number>();
      for (const c of contatos) for (const cul of new Set(c.culturas.map((x) => x.toLowerCase()))) porCultura.set(cul, (porCultura.get(cul) ?? 0) + 1);
      const porCidade = new Map<string, { nome: string; uf: string | null; n: number }>();
      for (const c of contatos) {
        if (!c.cidade) continue;
        const k = `${c.cidade}|${c.estado}`;
        porCidade.set(k, { nome: c.cidade, uf: c.estado, n: (porCidade.get(k)?.n ?? 0) + 1 });
      }
      const ordem = (a: { nome: string; n: number }, b: { nome: string; n: number }) => b.n - a.n || (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0);
      return {
        total,
        porStatus,
        responderam: resp.length,
        clientes: porStatus.cliente ?? 0,
        negociosAbertos: { n: deals.length, valor: Math.round(deals.reduce((a, d) => a + Number(d.valor), 0) * 100) / 100 },
        culturas: [...porCultura]
          .map(([nome, n]) => ({ nome, n }))
          .sort(ordem)
          .slice(0, 10)
          .map((c) => ({ nome: c.nome, pct: total ? Math.round((c.n / total) * 1000) / 10 : 0 })),
        cidades: [...porCidade.values()].sort(ordem).slice(0, 10),
        porCamada: contatos.reduce<Record<string, number>>((acc, c) => {
          const k = c.camadaId ?? "__none__";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        area: {
          comArea: contatos.filter((c) => c.areaHa != null).length,
          totalHa: Math.round(contatos.reduce((a, c) => a + (c.areaHa ?? 0), 0) * 10) / 10,
        },
      };
    }

    for (const [q, f] of [
      ["", {}],
      ["bbox=-58,-12,-54,-9", { bbox: [-58, -12, -54, -9] as [number, number, number, number] }],
      ["bbox=-58,-15,-54,-9&status=cliente,novo", { bbox: [-58, -15, -54, -9] as [number, number, number, number], status: ["cliente", "novo"] }],
    ] as const) {
      const obtido = await runWithTeam(TEAM, () => resumoDoMapa(filtrosDaQuery(new URLSearchParams(q))));
      const esperado = await oraculo(f);
      expect(esperado.total).toBeGreaterThan(5);
      // Soma de área em ponto flutuante: a ordem da soma (por camada no SQL, uma
      // a uma no oráculo) muda a última casa — compara com tolerância.
      expect(obtido.area.totalHa).toBeCloseTo(esperado.area.totalHa, 0);
      expect({
        ...obtido,
        negociosAbertos: { ...obtido.negociosAbertos, valor: Math.round(obtido.negociosAbertos.valor * 100) / 100 },
        area: { ...obtido.area, totalHa: esperado.area.totalHa },
      }).toEqual(esperado);
    }
  }, 60_000);
});

describe("filtros novos: camada, cidade, UF, área e faturamento", () => {
  async function cenario() {
    const cam = await basePrisma.mapaCamada.create({ data: { teamId: TEAM, nome: "5.000 ha", cor: "#A8321E" } });
    const sorriso = await basePrisma.contact.create({
      data: { teamId: TEAM, nome: "Sorriso", latitude: -12.5, longitude: -55.7, cidade: "Sorriso", estado: "MT", areaHa: 1200, faturamentoAnual: 5_000_000, camadaId: cam.id },
    });
    const sinop = await basePrisma.contact.create({
      data: { teamId: TEAM, nome: "Sinop", latitude: -11.8, longitude: -55.5, cidade: "Sinop", estado: "MT", areaHa: 6000 },
    });
    const lucas = await basePrisma.contact.create({
      data: { teamId: TEAM, nome: "Lucas", latitude: -13.0, longitude: -55.9, cidade: "Lucas do Rio Verde", estado: "MT" },
    });
    const goias = await basePrisma.contact.create({
      data: { teamId: TEAM, nome: "Goiás", latitude: -17.8, longitude: -50.9, cidade: "Rio Verde", estado: "GO", faturamentoAnual: 800_000 },
    });
    // O outro time tem contato igual (cidade, área, faturamento): nunca aparece para o A.
    await basePrisma.contact.create({
      data: { teamId: OUTRO, nome: "Sorriso B", latitude: -12.5, longitude: -55.7, cidade: "Sorriso", estado: "MT", areaHa: 1200, faturamentoAnual: 5_000_000 },
    });
    return { cam, sorriso, sinop, lucas, goias };
  }
  const nomes = async (q: string) => {
    const r = await pontos(TEAM, q);
    if (r.tipo !== "pontos") throw new Error("esperava pontos");
    return [...r.nome].sort();
  };

  it("camada: ids, 'sem camada' e os dois juntos; cada ponto traz a sua camada", async () => {
    const { cam, sorriso } = await cenario();
    expect(await nomes(`camada=${cam.id}`)).toEqual(["Sorriso"]);
    expect(await nomes("camada=__none__")).toEqual(["Goiás", "Lucas", "Sinop"]);
    expect(await nomes(`camada=${cam.id},__none__`)).toEqual(["Goiás", "Lucas", "Sinop", "Sorriso"]);
    const r = await pontos(TEAM, "");
    if (r.tipo !== "pontos") throw new Error("esperava pontos");
    expect(r.cam[r.ids.indexOf(sorriso.id)]).toBe(cam.id);
    expect(r.cam.filter((x) => x === null)).toHaveLength(3);
  });

  it("cidade parcial sem caixa, UF, área e faturamento de/até (número em pt-BR); nada do outro time", async () => {
    await cenario();
    expect(await nomes("cidade=sorr")).toEqual(["Sorriso"]);
    expect(await nomes("cidade=RIO VERDE")).toEqual(["Goiás", "Lucas"]);
    expect(await nomes("uf=go")).toEqual(["Goiás"]);
    expect(await nomes("areaMin=1000&areaMax=5000")).toEqual(["Sorriso"]);
    expect(await nomes("areaMin=1.000")).toEqual(["Sinop", "Sorriso"]); // "1.000" = mil
    expect(await nomes("fatMin=1000000")).toEqual(["Sorriso"]);
    expect(await nomes("fatMax=1.000.000")).toEqual(["Goiás"]);
    // % e _ digitados são literais, não curinga.
    expect(await nomes("cidade=%25")).toEqual([]);
    expect(await nomes("cidade=_")).toEqual([]);
  });

  it("resumo: contagem por camada e área somada da região", async () => {
    const { cam } = await cenario();
    const r = await runWithTeam(TEAM, () => resumoDoMapa(filtrosDaQuery(new URLSearchParams(""))));
    expect(r.porCamada).toEqual({ [cam.id]: 1, __none__: 3 });
    expect(r.area).toEqual({ comArea: 2, totalHa: 7200 });
    const soMT = await runWithTeam(TEAM, () => resumoDoMapa(filtrosDaQuery(new URLSearchParams("uf=MT&camada=__none__"))));
    expect(soMT.porCamada).toEqual({ __none__: 2 });
    expect(soMT.area).toEqual({ comArea: 1, totalHa: 6000 });
  });

  it("zod: mínimo acima do máximo, camada que não é id e UF com tamanho errado são recusados", () => {
    expect(() => filtrosDaQuery(new URLSearchParams("areaMin=10&areaMax=5"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("fatMin=10&fatMax=5"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("camada=nao-e-uuid"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("uf=MTX"))).toThrow(ZodError);
    expect(() => filtrosDaQuery(new URLSearchParams("areaMin=-1"))).toThrow(ZodError);
    expect(filtrosDaQuery(new URLSearchParams("areaMin=1.250,5&cidade="))).toEqual({ areaMin: 1250.5 });
  });
});

describe("contatosPerto", () => {
  it("raio em km, do mais perto ao mais longe, sem ele mesmo e sem o outro time", async () => {
    const alvo = await contato(TEAM, { nome: "Alvo", lat: -12.5425, lng: -55.7211 });
    await contato(TEAM, { nome: "5 km", lat: -12.5875, lng: -55.7211 });
    await contato(TEAM, { nome: "1 km", lat: -12.5515, lng: -55.7211 });
    await contato(TEAM, { nome: "80 km (Sinop)", lat: -11.8604, lng: -55.5091 });
    await contato(OUTRO, { nome: "Outro time a 100 m", lat: -12.5434, lng: -55.7211 });
    const r = await runWithTeam(TEAM, () => contatosPerto({ contactId: alvo.id, km: 15 }));
    expect(r.map((c) => c.nome)).toEqual(["1 km", "5 km"]);
    expect(r[0]!.km).toBeCloseTo(1, 0);
    expect(r[1]!.km).toBeCloseTo(5, 0);
    // Contato de outro time: não existe para este time.
    const deles = await basePrisma.contact.findFirstOrThrow({ where: { teamId: OUTRO } });
    await expect(runWithTeam(TEAM, () => contatosPerto({ contactId: deles.id }))).rejects.toMatchObject({ name: "ContactNotFound" });
  });
});

describe("rotaDoDia", () => {
  it("compromissos pendentes do dia (fuso de SP) em ordem de vizinho mais próximo, com link; fora: sem local, outro dia, feitos, outro time", async () => {
    const perto = await contato(TEAM, { nome: "Perto", lat: -12.55, lng: -55.72 });
    const longe = await contato(TEAM, { nome: "Longe", lat: -11.86, lng: -55.51 });
    const meio = await contato(TEAM, { nome: "Meio", lat: -12.2, lng: -55.6 });
    const semCoord = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Sem coordenada" } });
    const deles = await contato(OUTRO, { nome: "Do outro time", lat: -12.55, lng: -55.72 });
    // 2031-03-10 no fuso de SP (UTC-3): 00:00 = 03:00Z; 23:30 = 02:30Z do dia 11.
    const ap = (teamId: string, contactId: string | null, inicio: string, extra: Record<string, unknown> = {}) =>
      basePrisma.appointment.create({ data: { teamId, contactId, titulo: `Visita ${inicio}`, tipo: "reuniao", inicio: new Date(inicio), ...extra } });
    await ap(TEAM, longe.id, "2031-03-10T11:00:00Z");
    await ap(TEAM, perto.id, "2031-03-10T15:00:00Z");
    await ap(TEAM, meio.id, "2031-03-11T02:30:00Z"); // 23:30 em SP: ainda é dia 10
    await ap(TEAM, semCoord.id, "2031-03-10T12:00:00Z");
    await ap(TEAM, null, "2031-03-10T13:00:00Z");
    await ap(TEAM, perto.id, "2031-03-11T03:30:00Z"); // 00:30 do dia 11 em SP
    await ap(TEAM, meio.id, "2031-03-10T16:00:00Z", { status: "concluido" });
    await ap(OUTRO, deles.id, "2031-03-10T14:00:00Z");

    const origem = { lat: -12.6, lng: -55.75 }; // o vendedor saindo do sul de Sorriso
    const r = await runWithTeam(TEAM, () => rotaDoDia({ data: "2031-03-10", origem }));
    expect(r.paradas.map((p) => p.nome)).toEqual(["Perto", "Meio", "Longe"]);
    expect(r.semLocal).toHaveLength(2);
    expect(r.totalKm).toBeGreaterThan(80);
    const link = new URL(r.linkGoogleMaps!);
    expect(link.searchParams.get("origin")).toBe("-12.6,-55.75");
    expect(link.searchParams.get("destination")).toBe("-11.86,-55.51");
    expect(link.searchParams.get("waypoints")).toBe("-12.55,-55.72|-12.2,-55.6");
    expect(r.linkParcial).toBe(false);

    // Sem posição do vendedor: parte do 1º compromisso do dia.
    const semOrigem = await runWithTeam(TEAM, () => rotaDoDia({ data: "2031-03-10" }));
    expect(semOrigem.paradas[0]!.nome).toBe("Longe");
    expect(semOrigem.paradas[0]!.km).toBe(0);
  });

  it("vizinho mais próximo e link com mais paradas do que o Maps aceita", () => {
    const pts = [{ lat: 0, lng: 3 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }];
    expect(ordenarPorVizinhoMaisProximo(pts, { lat: 0, lng: 0 }).map((p) => p.lng)).toEqual([1, 2, 3]);
    const muitas = Array.from({ length: 14 }, (_, i) => ({ lat: -12 - i * 0.01, lng: -55 }));
    const l = linkGoogleMaps({ lat: -11.9, lng: -55 }, muitas);
    expect(l.parcial).toBe(true);
    expect(new URL(l.url!).searchParams.get("waypoints")!.split("|")).toHaveLength(9);
    expect(linkGoogleMaps(null, [])).toEqual({ url: null, parcial: false });
  });
});
