import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { CnpjNotFound } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { redisCache, redisEstado } from "../shared/redis-cache";

// Fila `capture` mockada: a lista grande só é ENFILEIRADA aqui.
const adicionados: { data: unknown; opts: { jobId?: string } }[] = [];
vi.mock("bullmq", () => ({
  Queue: class {
    async add(_nome: string, data: unknown, opts: { jobId?: string }) {
      adicionados.push({ data, opts });
    }
  },
}));

import {
  consultarCnpj,
  captureCnpjs,
  executarCaptura,
  coletarLoteCnpj,
  statusDaCaptura,
  lerStatusCaptura,
  tomarFichaCnpja,
  chaveCacheCnpj,
  CHAVE_FICHAS_CNPJA,
  CHAVE_PAUSA_OPENCNPJ,
  CNPJ_SINCRONO_MAX,
  LoteCnpjGrandeDemais,
} from "./index";
import { CnpjEnricher } from "../enrichment/cnpj";
import { toolsForMode } from "../ai/tools";

/**
 * CNPJ compartilhado (item 3.2, INT-13): cache `cnpj:<dígitos>` de 30 dias
 * entre times, captação, enriquecimento e IA; fichas globais do CNPJá (5/min
 * por IP); timeout + 1 retry em 5xx; lista grande na fila `capture`; `fonte` e
 * `parcial` no rascunho. `fetch` é FALSO — nada vai ao CNPJá nem à BrasilAPI.
 */
const TEAM = "00000000-0000-0000-0000-0000000004a3";
const OUTRO = "00000000-0000-0000-0000-0000000004a4";

// CNPJs de teste (14 dígitos, formato válido para o normalizador; não existem).
const cnpjDeTeste = (i: number) => `9${String(i).padStart(13, "0")}`;
const TODOS = Array.from({ length: 12 }, (_, i) => cnpjDeTeste(i + 1));

type Resposta = { status: number; body?: unknown };
const chamadas: { host: "cnpja" | "opencnpj" | "brasilapi"; cnpj: string; temSinal: boolean }[] = [];
let respostaCnpja: (cnpj: string, n: number) => Resposta;
let respostaOpen: (cnpj: string, n: number) => Resposta;
let respostaBrasil: (cnpj: string, n: number) => Resposta;

const corpoCnpja = (cnpj: string) => ({
  company: {
    name: `Razão ${cnpj}`,
    members: [{ person: { name: "Sócia Teste" }, role: { text: "Sócio-Administrador" } }],
    size: { text: "Microempresa" },
    equity: 10000,
  },
  alias: `Fantasia ${cnpj}`,
  address: { street: "Rua A", number: "1", city: "Sorriso", state: "MT" },
  phones: [{ area: "66", number: "35441234" }],
  emails: [{ address: "Contato@Exemplo.test" }],
  mainActivity: { id: 115600, text: "Cultivo de soja" },
  status: { text: "Ativa" },
});
const corpoBrasil = (cnpj: string) => ({
  cnpj,
  razao_social: `Razão BR ${cnpj}`,
  nome_fantasia: `Fantasia BR ${cnpj}`,
  municipio: "Sinop",
  uf: "MT",
  ddd_telefone_1: "6635001234",
  cnae_fiscal: "0115600",
  cnae_fiscal_descricao: "Cultivo de soja",
  qsa: [{ nome_socio: "Fulano de Tal", qualificacao_socio: "Sócio" }],
  porte: "MICRO EMPRESA",
  capital_social: 5000,
});

// OpenCNPJ (api.opencnpj.org): no formato dela (e-mail, telefones, QSA, cnaes).
const corpoOpen = (cnpj: string) => ({
  cnpj,
  razao_social: `Razão Open ${cnpj}`,
  nome_fantasia: "",
  situacao_cadastral: "Ativa",
  cnae_principal: "0115600",
  cnaes: [
    { codigo: "0115600", descricao: "Cultivo de soja", is_principal: true },
    { codigo: "0111302", descricao: "Cultivo de milho", is_principal: false },
  ],
  municipio: "SORRISO",
  uf: "MT",
  email: "Contador@Exemplo.test",
  telefones: [{ ddd: "66", numero: "35441234", is_fax: false }],
  capital_social: "80000,00",
  porte_empresa: "Demais",
  QSA: [{ nome_socio: "Sócia Open", qualificacao_socio: "Sócio-Administrador" }],
});

const fetchFalso = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const host = u.includes("open.cnpja.com") ? "cnpja" : u.includes("api.opencnpj.org") ? "opencnpj" : "brasilapi";
  const cnpj = u.split("/").pop()!;
  chamadas.push({ host, cnpj, temSinal: init?.signal instanceof AbortSignal });
  const n = chamadas.filter((c) => c.host === host && c.cnpj === cnpj).length;
  const r = host === "cnpja" ? respostaCnpja(cnpj, n) : host === "opencnpj" ? respostaOpen(cnpj, n) : respostaBrasil(cnpj, n);
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
});

const naRede = (host: "cnpja" | "opencnpj" | "brasilapi") => chamadas.filter((c) => c.host === host).length;

async function limparFichas() {
  await redisEstado().del(CHAVE_FICHAS_CNPJA);
}
/** Gasta todas as fichas da janela (simula outros times usando o CNPJá). */
async function esgotarFichas() {
  while (await tomarFichaCnpja()) {
    /* consome até acabar */
  }
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team CNPJ A (test)"], [OUTRO, "Team CNPJ B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  for (const r of [redisCache(), redisEstado()]) {
    if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
  }
});

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchFalso);
  chamadas.length = 0;
  adicionados.length = 0;
  respostaCnpja = (c) => ({ status: 200, body: corpoCnpja(c) });
  respostaBrasil = (c) => ({ status: 200, body: corpoBrasil(c) });
  respostaOpen = () => ({ status: 404 }); // por padrão a OpenCNPJ "não tem" o CNPJ: o resto do fluxo segue como antes
  await limparFichas();
  await redisEstado().del(CHAVE_PAUSA_OPENCNPJ);
  await redisCache().del(...TODOS.map(chaveCacheCnpj));
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: OUTRO } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("consultarCnpj — cache compartilhado", () => {
  it("1ª consulta vai ao CNPJá; o outro time, o enriquecimento e a IA leem do cache (sem rede)", async () => {
    const d = TODOS[0]!;
    const r1 = await runWithTeam(TEAM, () => consultarCnpj(d));
    expect(r1).toMatchObject({ cnpj: d, fonte: "cnpja", parcial: false, email: "contato@exemplo.test", nomeSocio: "Sócia Teste" });
    expect(r1.socios).toEqual([{ nome: "Sócia Teste", qualificacao: "Sócio-Administrador" }]);
    expect(naRede("cnpja")).toBe(1);

    const r2 = await runWithTeam(OUTRO, () => consultarCnpj(`${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`));
    expect(r2).toEqual(r1);

    const enr = await CnpjEnricher.run({ id: "empresa-teste", cnpj: d, cnae: null }, {} as never);
    expect(enr?.source).toBe("cnpja");

    const tool = toolsForMode("read_only").find((t) => t.def.name === "lookup_cnpj")!;
    const ia = (await tool.run({ cnpj: d }, {} as never)) as Record<string, unknown>;
    expect(ia).toMatchObject({ razaoSocial: `Razão ${d}`, fonte: "cnpja", socios: [{ nome: "Sócia Teste", qualificacao: "Sócio-Administrador" }] });

    expect(chamadas).toHaveLength(1); // uma ida à rede para os quatro
  });

  it("não encontrado fica em cache: a 2ª consulta nem vai à rede", async () => {
    const d = TODOS[1]!;
    respostaCnpja = () => ({ status: 404 });
    await expect(consultarCnpj(d)).rejects.toBeInstanceOf(CnpjNotFound);
    await expect(consultarCnpj(d)).rejects.toBeInstanceOf(CnpjNotFound);
    expect(chamadas).toHaveLength(1);
  });

  it("parcial em cache (só BrasilAPI) melhora pelo CNPJá quando há ficha", async () => {
    const d = TODOS[2]!;
    await esgotarFichas();
    const parcial = await consultarCnpj(d);
    expect(parcial).toMatchObject({ fonte: "brasilapi", parcial: true, socios: [{ nome: "Fulano de Tal", qualificacao: "Sócio" }] });
    // Sem ficha, o parcial em cache basta (não martela a BrasilAPI de novo).
    expect(await consultarCnpj(d)).toMatchObject({ fonte: "brasilapi" });
    expect(naRede("brasilapi")).toBe(1);

    await limparFichas();
    const rico = await consultarCnpj(d);
    expect(rico).toMatchObject({ fonte: "cnpja", parcial: false });
    expect(await consultarCnpj(d)).toMatchObject({ fonte: "cnpja" }); // cache atualizado
    expect(naRede("cnpja")).toBe(1);
  });
});

describe("consultarCnpj — OpenCNPJ (gratuita, com e-mail) entre o CNPJá e a BrasilAPI", () => {
  it("sem ficha do CNPJá: a OpenCNPJ responde com e-mail, telefone e sócios; a BrasilAPI nem é chamada", async () => {
    const d = TODOS[4]!;
    await esgotarFichas();
    respostaOpen = (c) => ({ status: 200, body: corpoOpen(c) });
    const r = await consultarCnpj(d);
    expect(r).toMatchObject({
      cnpj: d,
      fonte: "opencnpj",
      parcial: true,
      razaoSocial: `Razão Open ${d}`,
      email: "contador@exemplo.test",
      telefone: "(66) 3544-1234",
      cnae: "0115600",
      cnaesSecundarios: [{ codigo: "0111302", descricao: "Cultivo de milho" }],
      socios: [{ nome: "Sócia Open", qualificacao: "Sócio-Administrador" }],
      capitalSocial: 80000,
      porte: "Demais",
    });
    expect(naRede("opencnpj")).toBe(1);
    expect(naRede("brasilapi")).toBe(0);
    expect(await consultarCnpj(d)).toMatchObject({ fonte: "opencnpj" }); // cache: sem nova ida à rede
    expect(naRede("opencnpj")).toBe(1);
  });

  it("OpenCNPJ barrando (429) ou sem o CNPJ (404): cai na BrasilAPI", async () => {
    await esgotarFichas();
    respostaOpen = () => ({ status: 429 });
    expect(await consultarCnpj(TODOS[5]!)).toMatchObject({ fonte: "brasilapi" });
    respostaOpen = () => ({ status: 404 });
    expect(await consultarCnpj(TODOS[6]!)).toMatchObject({ fonte: "brasilapi" });
  });

  it("cache que veio só da BrasilAPI melhora pela OpenCNPJ quando ela passa a responder", async () => {
    const d = TODOS[7]!;
    await esgotarFichas();
    expect(await consultarCnpj(d)).toMatchObject({ fonte: "brasilapi" });
    respostaOpen = (c) => ({ status: 200, body: corpoOpen(c) });
    expect(await consultarCnpj(d)).toMatchObject({ fonte: "opencnpj", email: "contador@exemplo.test" });
  });

  it("429 da OpenCNPJ: cai na BrasilAPI e a OpenCNPJ fica em pausa por um minuto, para todos", async () => {
    await esgotarFichas();
    respostaOpen = () => ({ status: 429 });
    expect(await consultarCnpj(TODOS[9]!)).toMatchObject({ fonte: "brasilapi" });
    expect(naRede("opencnpj")).toBe(1);
    expect(await redisEstado().ttl(CHAVE_PAUSA_OPENCNPJ)).toBeGreaterThan(0);
    // Em pausa: o próximo CNPJ nem tenta a OpenCNPJ (mesmo que ela já tenha voltado).
    respostaOpen = (c) => ({ status: 200, body: corpoOpen(c) });
    expect(await consultarCnpj(TODOS[10]!)).toMatchObject({ fonte: "brasilapi" });
    expect(naRede("opencnpj")).toBe(1);
    // Passada a pausa, volta a usar.
    await redisEstado().del(CHAVE_PAUSA_OPENCNPJ);
    expect(await consultarCnpj(TODOS[11]!)).toMatchObject({ fonte: "opencnpj" });
  });

  it("a ficha do CNPJá continua mandando: com ficha, o CNPJá vem antes e a OpenCNPJ não é chamada", async () => {
    respostaOpen = (c) => ({ status: 200, body: corpoOpen(c) });
    expect(await consultarCnpj(TODOS[8]!)).toMatchObject({ fonte: "cnpja", parcial: false });
    expect(naRede("opencnpj")).toBe(0);
  });
});

describe("consultarCnpj — fichas do CNPJá (5/min por IP, global)", () => {
  it("7 CNPJs seguidos: 5 no CNPJá; os outros 2 direto na BrasilAPI, sem bater no 429", async () => {
    const rs = [];
    for (const d of TODOS.slice(0, 7)) rs.push(await consultarCnpj(d));
    expect(naRede("cnpja")).toBe(5);
    expect(naRede("brasilapi")).toBe(2);
    expect(rs.map((r) => r.fonte)).toEqual(["cnpja", "cnpja", "cnpja", "cnpja", "cnpja", "brasilapi", "brasilapi"]);
  });

  it("429 do CNPJá mesmo assim (outro app no IP): esvazia as fichas e os próximos vão direto à BrasilAPI", async () => {
    respostaCnpja = () => ({ status: 429 });
    const r = await consultarCnpj(TODOS[0]!);
    expect(r.fonte).toBe("brasilapi");
    respostaCnpja = (c) => ({ status: 200, body: corpoCnpja(c) });
    await consultarCnpj(TODOS[1]!);
    await consultarCnpj(TODOS[2]!);
    expect(naRede("cnpja")).toBe(1); // só o que levou 429
    expect(naRede("brasilapi")).toBe(3);
  });

  it("toda ida à rede tem teto (AbortSignal) e 5xx ganha 1 nova tentativa", async () => {
    await esgotarFichas();
    respostaBrasil = (c, n) => (n === 1 ? { status: 503 } : { status: 200, body: corpoBrasil(c) });
    const r = await consultarCnpj(TODOS[3]!);
    expect(r.fonte).toBe("brasilapi");
    expect(naRede("brasilapi")).toBe(2);
    expect(chamadas.every((c) => c.temSinal)).toBe(true);
  });
});

describe("captureCnpjs — na hora ou na fila", () => {
  it(`até ${CNPJ_SINCRONO_MAX}: consulta na hora; inválido e duplicado tratados; rascunho com fonte/parcial`, async () => {
    const [a, b] = TODOS;
    const formatado = `${a!.slice(0, 2)}.${a!.slice(2, 5)}.${a!.slice(5, 8)}/${a!.slice(8, 12)}-${a!.slice(12)}`;
    const r = await runWithTeam(TEAM, () => captureCnpjs([a!, formatado, "123", b!]));
    expect(r.criados).toBe(2);
    expect(r.enfileirados).toBeUndefined();
    expect(r.falhas).toEqual([{ cnpj: "123", motivo: "CNPJ inválido" }]);
    expect(naRede("cnpja")).toBe(2); // o duplicado (formatado) não foi consultado de novo

    const drafts = await basePrisma.prospectDraft.findMany({ where: { teamId: TEAM, lote: r.lote } });
    expect(drafts).toHaveLength(2);
    for (const d of drafts) expect(d.extra).toMatchObject({ fonte: "cnpja", parcial: false });
    expect(await runWithTeam(TEAM, () => statusDaCaptura(r.lote))).toMatchObject({ estado: "concluida", criados: 2, falhas: 1 });
    expect(await runWithTeam(OUTRO, () => statusDaCaptura(r.lote))).toBeNull();
  });

  it(`acima de ${CNPJ_SINCRONO_MAX}: vai para a fila capture (sem consultar na action)`, async () => {
    const lista = TODOS.slice(0, 7);
    const r = await runWithTeam(TEAM, () => captureCnpjs([...lista, "x"]));
    expect(r).toMatchObject({ criados: 0, enfileirados: 7, falhas: [{ cnpj: "x", motivo: "CNPJ inválido" }] });
    expect(chamadas).toHaveLength(0);
    expect(adicionados).toHaveLength(1);
    // F3: o job leva quem pediu (a fila da captação é por pessoa).
    expect(adicionados[0]!.data).toEqual({ origem: "cnpj", teamId: TEAM, lote: r.lote, cnpjs: lista, ownerId: "dono-teste" });
    expect(await runWithTeam(TEAM, () => statusDaCaptura(r.lote))).toMatchObject({ estado: "na_fila", total: 7, origem: "cnpj" });
  });

  it("lista acima do teto é recusada com erro nomeado; viewer não captura", async () => {
    const enorme = Array.from({ length: 501 }, (_, i) => `8${String(i).padStart(13, "0")}`);
    await expect(runWithTeam(TEAM, () => captureCnpjs(enorme))).rejects.toBeInstanceOf(LoteCnpjGrandeDemais);
    await expect(runWithTeam(TEAM, () => captureCnpjs([TODOS[0]!]), { userId: "v", role: "viewer" })).rejects.toThrow();
    expect(chamadas).toHaveLength(0);
  });
});

describe("lote de CNPJ no worker (executarCaptura + coletarLoteCnpj)", () => {
  it("grava cada CNPJ assim que chega, com fonte/parcial; falha conta e não derruba o lote", async () => {
    const lista = TODOS.slice(0, 7);
    respostaCnpja = (c) => (c === lista[1] ? { status: 404 } : { status: 200, body: corpoCnpja(c) });
    respostaBrasil = (c) => (c === lista[1] ? { status: 404 } : { status: 200, body: corpoBrasil(c) });
    const lote = crypto.randomUUID();
    const st = await executarCaptura({ origem: "cnpj", teamId: TEAM, lote, cnpjs: lista }, coletarLoteCnpj(lista, { pausaMs: 0 }));
    expect(st).toMatchObject({ estado: "concluida", criados: 6, falhas: 1, processados: 7, total: 7 });
    expect(st.falhasAmostra).toEqual([{ item: lista[1], motivo: "não encontrado" }]);

    const drafts = await basePrisma.prospectDraft.findMany({ where: { teamId: TEAM, lote } });
    expect(drafts).toHaveLength(6);
    const fontes = drafts.map((d) => (d.extra as { fonte: string; parcial: boolean }).fonte).sort();
    // 1 ficha foi no 404; as outras 4 fichas → CNPJá; o resto → BrasilAPI (parcial).
    expect(fontes).toEqual(["brasilapi", "brasilapi", "cnpja", "cnpja", "cnpja", "cnpja"]);
    expect(await basePrisma.prospectDraft.count({ where: { teamId: OUTRO } })).toBe(0);
    expect(await lerStatusCaptura(OUTRO, lote)).toBeNull();
  });

  it("teto do lote estourado: para com o que já veio e marca 'parcial' com quantos ficaram de fora", async () => {
    const lista = TODOS.slice(0, 3);
    const lote = crypto.randomUUID();
    // Relógio falso: o teto estoura logo depois do 1º CNPJ.
    const tempos = [0, 0, 60 * 60_000];
    const agora = () => tempos.shift() ?? 60 * 60_000;
    const st = await executarCaptura(
      { origem: "cnpj", teamId: TEAM, lote, cnpjs: lista },
      coletarLoteCnpj(lista, { pausaMs: 0, tetoMs: 20 * 60_000, agora }),
    );
    expect(st).toMatchObject({ estado: "parcial", motivo: "tempo_esgotado", criados: 1, processados: 1 });
    expect(st.mensagem).toMatch(/2 CNPJ\(s\) não consultado/);
    expect(await basePrisma.prospectDraft.count({ where: { teamId: TEAM, lote } })).toBe(1);
  });
});
