import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { coletarSeguidoresInstagram, extrairAvaliacaoMaps, parseAvaliacaoMaps } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import { ForbiddenError } from "../auth/authz";
import {
  executarCaptura,
  insertDrafts,
  listDrafts,
  extrasDoRascunho,
  marcarTemWhatsAppDoLote,
  type CaptureJob,
  type ContextoColeta,
  type DraftInput,
} from "./index";

/**
 * Captação — dados que faltam nas telas (produto §H.2–H.6):
 * - avaliação do Maps e bio do Instagram lidas de HTML/JSON de EXEMPLO
 *   (fixtures/), sem acessar site real;
 * - "tem WhatsApp?" na fila pela checagem do A.4 — a Evolution é um `fetch`
 *   falso que só aceita `/chat/whatsappNumbers` (qualquer outro endpoint,
 *   inclusive de envio, estoura o teste);
 * - rótulo de produtor nos rascunhos de CNPJ e filtros do `listDrafts`.
 */

const TEAM = "00000000-0000-0000-0000-0000000007a3";
const OUTRO = "00000000-0000-0000-0000-0000000007a4";
const TIMES = [TEAM, OUTRO];

const fixture = (nome: string) => readFileSync(new URL(`./fixtures/${nome}`, import.meta.url), "utf8");

/** Os `aria-label` de um HTML, como o `querySelectorAll("[aria-label]")` do worker os devolve. */
function rotulosDoHtml(html: string): string[] {
  const ent: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!.replace(/&(amp|quot|#39|lt|gt);/g, (e) => ent[e]!));
}
/** Texto visível de um trecho (o `innerText` do bloco .F7nice). */
const textoDe = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ─── Maps: avaliação (H.4) ──────────────────────────────────────────────────

describe("Maps — avaliação e nº de avaliações (fixtures)", () => {
  it("card do feed em pt-BR: '4,8 estrelas 61 avaliações'", () => {
    expect(extrairAvaliacaoMaps(rotulosDoHtml(fixture("maps-card-pt.html")))).toEqual({ avaliacao: 4.8, avaliacoes: 61 });
  });

  it("card em inglês, milhar com vírgula: '4.6 stars 1,234 Reviews'", () => {
    expect(extrairAvaliacaoMaps(rotulosDoHtml(fixture("maps-card-en.html")))).toEqual({ avaliacao: 4.6, avaliacoes: 1234 });
  });

  it("lugar sem avaliação: nada inventado (nome e 'Rotas para…' não viram nota)", () => {
    expect(extrairAvaliacaoMaps(rotulosDoHtml(fixture("maps-card-sem-avaliacao.html")))).toEqual({ avaliacao: null, avaliacoes: null });
  });

  it("ficha: nota e contagem em rótulos separados, e o bloco visível '4,8(1.234)'", () => {
    const html = fixture("maps-ficha.html");
    expect(extrairAvaliacaoMaps(rotulosDoHtml(html))).toEqual({ avaliacao: 4.8, avaliacoes: 1234 });
    const f7nice = html.match(/<div class="F7nice">([\s\S]*?)<\/div>/)![1]!;
    expect(parseAvaliacaoMaps(textoDe(f7nice))).toEqual({ avaliacao: 4.8, avaliacoes: 1234 });
    // O telefone e o endereço da ficha não confundem o parser.
    expect(parseAvaliacaoMaps("Telefone: (66) 99999-0000")).toEqual({ avaliacao: null, avaliacoes: null });
  });

  it("nome do lugar que parece nota ('Pousada 5.0 Estrelas') não vira nota (auditoria do #133)", () => {
    const rotulos = rotulosDoHtml(fixture("maps-card-nome-com-nota.html"));
    expect(extrairAvaliacaoMaps(rotulos, { nome: "Pousada 5.0 Estrelas" })).toEqual({ avaliacao: 4.6, avaliacoes: 12 });
    // Sem o nome, o 1º rótulo (o próprio nome) enganaria o parser — por isso o worker passa o nome.
    expect(extrairAvaliacaoMaps(rotulos).avaliacao).toBe(5);
    // Nome curto só filtra o rótulo idêntico ("Est" está dentro de "estrelas").
    expect(extrairAvaliacaoMaps(["Est", "4,2 estrelas 9 avaliações"], { nome: "Est" })).toEqual({ avaliacao: 4.2, avaliacoes: 9 });
  });

  it("card primeiro, ficha de reserva; formatos de borda", () => {
    expect(extrairAvaliacaoMaps(["Fazenda X", "4,8 estrelas ", "5,0 estrelas 1 avaliação"])).toEqual({ avaliacao: 4.8, avaliacoes: 1 });
    expect(parseAvaliacaoMaps("5,0 estrelas 1 avaliação")).toEqual({ avaliacao: 5, avaliacoes: 1 });
    expect(parseAvaliacaoMaps("Nenhuma avaliação")).toEqual({ avaliacao: null, avaliacoes: null });
    expect(parseAvaliacaoMaps("9,9 estrelas")).toEqual({ avaliacao: null, avaliacoes: null }); // fora de 1–5
    expect(parseAvaliacaoMaps(null)).toEqual({ avaliacao: null, avaliacoes: null });
  });
});

// ─── Instagram: bio (H.5) ───────────────────────────────────────────────────

const PERFIL_JSON = JSON.parse(fixture("instagram-web-profile-info.json")) as { data: { user: { biography: string } } };
const BIO = PERFIL_JSON.data.user.biography;

type Resp = { status: number; body?: unknown };

/**
 * fetch falso do Instagram: `web_profile_info` do perfil-alvo → id; o de cada
 * seguidor → `bios[username]` (padrão: o JSON de exemplo); `followers` → páginas.
 */
function instagramFalso(paginas: Resp[], bios: Record<string, Resp> = {}) {
  const urls: string[] = [];
  const sinais: boolean[] = [];
  let p = 0;
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    sinais.push(init?.signal instanceof AbortSignal);
    let r: Resp;
    if (u.includes("/friendships/")) r = paginas[p++] ?? { status: 200, body: { users: [] } };
    else {
      const username = new URL(u).searchParams.get("username")!;
      r = username === "perfil_alvo" ? { status: 200, body: { data: { user: { id: "999" } } } } : bios[username] ?? { status: 200, body: PERFIL_JSON };
    }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchImpl: f as unknown as typeof fetch, urls, sinais };
}

const pagina = (de: number, n: number, proxima: string | null): Resp => ({
  status: 200,
  body: { users: Array.from({ length: n }, (_, k) => ({ username: `seg_${de + k}`, full_name: `Seguidor ${de + k}` })), next_max_id: proxima },
});

describe("Instagram — bio do perfil (fixture JSON)", () => {
  it("busca a bio só até o teto, com pausa entre perfis e teto de tempo em toda requisição", async () => {
    const { fetchImpl, urls, sinais } = instagramFalso([pagina(0, 3, null)]);
    const esperas: number[] = [];
    const recebidos: { username: string; bio: string | null }[] = [];
    const r = await coletarSeguidoresInstagram({
      cookie: "sessionid=falso",
      perfil: "@perfil_alvo",
      limite: 10,
      bios: { max: 2 },
      fetchImpl,
      esperar: async (ms) => void esperas.push(ms),
      aoPagina: async (itens) => void recebidos.push(...itens.map((u) => ({ username: u.username, bio: u.bio }))),
    });
    expect(r).toMatchObject({ lidos: 3, interrupcao: null });
    expect(recebidos).toEqual([
      { username: "seg_0", bio: BIO },
      { username: "seg_1", bio: BIO },
      { username: "seg_2", bio: null }, // fora do teto: nenhuma requisição
    ]);
    expect(urls.filter((u) => u.includes("username=seg_"))).toHaveLength(2);
    expect(esperas.filter((ms) => ms >= 1500)).toHaveLength(2); // pausa antes de cada bio
    expect(sinais.every(Boolean)).toBe(true);
  });

  it("sem `bios`: nenhuma requisição extra (comportamento de antes)", async () => {
    const { fetchImpl, urls } = instagramFalso([pagina(0, 5, null)]);
    await coletarSeguidoresInstagram({ cookie: "x", perfil: "perfil_alvo", limite: 10, fetchImpl, esperar: async () => {}, aoPagina: async () => {} });
    expect(urls.filter((u) => u.includes("username=seg_"))).toHaveLength(0);
  });

  it("429 na bio PARA a coleta: a página vai para a fila com as bios já lidas", async () => {
    const { fetchImpl, urls } = instagramFalso([pagina(0, 4, "prox"), pagina(4, 4, null)], { seg_2: { status: 429 } });
    const recebidos: { username: string; bio: string | null }[] = [];
    const r = await coletarSeguidoresInstagram({
      cookie: "x",
      perfil: "perfil_alvo",
      limite: 50,
      bios: { max: 10 },
      fetchImpl,
      esperar: async () => {},
      aoPagina: async (itens) => void recebidos.push(...itens.map((u) => ({ username: u.username, bio: u.bio }))),
    });
    expect(r.interrupcao).toMatchObject({ motivo: "limite_instagram" });
    expect(r.lidos).toBe(4);
    expect(recebidos.map((u) => u.bio)).toEqual([BIO, BIO, null, null]);
    expect(urls.filter((u) => u.includes("/friendships/"))).toHaveLength(1); // não pediu a 2ª página
    expect(urls.some((u) => u.includes("username=seg_3"))).toBe(false); // nem a bio seguinte
  });

  it("perfil sumido (404) ou JSON estranho numa bio: só aquela bio fica vazia", async () => {
    const { fetchImpl } = instagramFalso([pagina(0, 3, null)], {
      seg_0: { status: 404 },
      seg_1: { status: 200, body: { data: { user: { id: "1", biography: 42 } } } },
    });
    const bios: (string | null)[] = [];
    const r = await coletarSeguidoresInstagram({
      cookie: "x",
      perfil: "perfil_alvo",
      limite: 10,
      bios: { max: 5 },
      fetchImpl,
      esperar: async () => {},
      aoPagina: async (itens) => void bios.push(...itens.map((u) => u.bio)),
    });
    expect(r.interrupcao).toBeNull();
    expect(bios).toEqual([null, null, BIO]);
  });
});

// ─── Banco: produtor, tem WhatsApp, filtros ─────────────────────────────────

/** Faixa de números só deste teste (o cache WhatsAppNumberCheck é global). */
const PREFIXO = "+55669887";
const num = (i: number) => `${PREFIXO}${String(i).padStart(5, "0")}`;

type Evo = { exists: boolean };
const evolution = new Map<string, Evo>();
const chamadasEvo: { url: string; numbers: string[] }[] = [];
const fetchEvolution = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (!u.includes("/chat/whatsappNumbers/")) throw new Error(`endpoint proibido no teste: ${u}`);
  const numbers = (JSON.parse(String(init?.body)) as { numbers: string[] }).numbers;
  chamadasEvo.push({ url: u, numbers });
  // A Evolution recebe só dígitos (sem "+") e ecoa o número em `number`.
  const corpo = numbers.flatMap((n) => {
    const r = evolution.get(`+${n}`);
    return r ? [{ exists: r.exists, jid: `${n}@s.whatsapp.net`, number: n }] : [];
  });
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "Content-Type": "application/json" } });
});

const contas: string[] = [];
async function contaWhatsApp(teamId: string, status: "connected" | "disconnected" = "connected") {
  const c = await basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: "WhatsApp (test G)", provider: "evolution", externalId: `inst-g-${randomUUID().slice(0, 8)}`, status },
  });
  contas.push(c.id);
  return c;
}

async function limpar() {
  for (const teamId of TIMES) {
    await basePrisma.prospectDraft.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
  await basePrisma.whatsAppNumberCheck.deleteMany({ where: { numero: { startsWith: PREFIXO } } });
  const hoje = new Date().toISOString().slice(0, 10);
  for (const id of contas.splice(0)) await redisEstado().del(`wa:checagem:${id}:${hoje}`);
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Captação extras (test G)"], [OUTRO, "Team Captação extras B (test G)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
  vi.stubGlobal("fetch", fetchEvolution);
});
beforeEach(async () => {
  evolution.clear();
  chamadasEvo.length = 0;
  await limpar();
});
afterAll(async () => {
  await limpar();
  vi.unstubAllGlobals();
});

/** Coletor falso: grava os itens dados, como o worker faria com o scraping. */
const coletorCom = (itens: DraftInput[]) => async (ctx: ContextoColeta) => {
  await ctx.gravar(itens);
  ctx.progresso(itens.length);
  return { interrupcao: null };
};
const jobMaps = (teamId: string): CaptureJob => ({ origem: "maps", teamId, lote: randomUUID(), termo: "fazenda", limite: 10 });

async function extrasDoLote(teamId: string, lote: string) {
  const rows = await basePrisma.prospectDraft.findMany({ where: { teamId, lote }, orderBy: { nome: "asc" } });
  return Object.fromEntries(rows.map((r) => [r.nome, r.extra as Record<string, unknown> | null]));
}

describe("tem WhatsApp? na fila (H.2) — pela checagem do A.4, sem enviar", () => {
  it("marca true/false/null ao fim da captura, pela conta conectada do time, sem perder o resto do extra", async () => {
    await contaWhatsApp(TEAM);
    evolution.set(num(1), { exists: true });
    evolution.set(num(2), { exists: false });
    // num(3): a Evolution não responde nada sobre ele → "não sei".
    // num(4): já no cache global (checado ontem) → não vai à Evolution.
    await basePrisma.whatsAppNumberCheck.create({ data: { numero: num(4), existe: true, checkedAt: new Date(Date.now() - 86_400_000) } });

    const job = jobMaps(TEAM);
    const st = await executarCaptura(
      job,
      coletorCom([
        { nome: "A com", telefone: num(1), extra: { endereco: "Rua A", avaliacao: 4.8, avaliacoes: 61 } },
        { nome: "B sem", telefone: num(2), extra: { endereco: "Rua B" } },
        { nome: "C ?", telefone: num(3) },
        { nome: "D cache", telefone: num(4) },
        { nome: "E sem telefone", telefone: null },
      ]),
    );
    expect(st.estado).toBe("concluida");

    const ex = await extrasDoLote(TEAM, job.lote);
    expect(ex["A com"]).toEqual({ endereco: "Rua A", avaliacao: 4.8, avaliacoes: 61, temWhatsApp: true });
    expect(ex["B sem"]).toEqual({ endereco: "Rua B", temWhatsApp: false });
    expect(ex["C ?"]).toEqual({ temWhatsApp: null });
    expect(ex["D cache"]).toEqual({ temWhatsApp: true });
    expect(ex["E sem telefone"]).toBeNull();

    // Uma ida só à Evolution, só com quem não estava no cache, e só no endpoint de checagem.
    expect(chamadasEvo).toHaveLength(1);
    expect(chamadasEvo[0]!.numbers.sort()).toEqual([num(1), num(2), num(3)].map((n) => n.slice(1)).sort());
    expect(fetchEvolution.mock.calls.every(([u]) => String(u).includes("/chat/whatsappNumbers/"))).toBe(true);
  });

  it("sem conta conectada: só o cache responde; nada vai à Evolution", async () => {
    await contaWhatsApp(TEAM, "disconnected");
    await basePrisma.whatsAppNumberCheck.create({ data: { numero: num(10), existe: false } });
    const job = jobMaps(TEAM);
    await executarCaptura(job, coletorCom([{ nome: "Cache", telefone: num(10) }, { nome: "Novo", telefone: num(11) }]));
    const ex = await extrasDoLote(TEAM, job.lote);
    expect(ex).toEqual({ Cache: { temWhatsApp: false }, Novo: { temWhatsApp: null } });
    expect(chamadasEvo).toHaveLength(0);
  });

  it("dois times: a conta de outro time nunca é usada para checar a fila", async () => {
    await contaWhatsApp(OUTRO); // só o OUTRO tem WhatsApp conectado
    evolution.set(num(20), { exists: true });
    const job = jobMaps(TEAM);
    await executarCaptura(job, coletorCom([{ nome: "Lead", telefone: num(20) }]));
    expect((await extrasDoLote(TEAM, job.lote)).Lead).toEqual({ temWhatsApp: null });
    expect(chamadasEvo).toHaveLength(0);
    expect(await basePrisma.prospectDraft.count({ where: { teamId: OUTRO } })).toBe(0);
  });

  it("RBAC (auditoria do #133): viewer não marca nem gasta a cota da conta; o sistema (worker) marca", async () => {
    await contaWhatsApp(TEAM);
    evolution.set(num(50), { exists: true });
    const lote = randomUUID();
    await runWithTeam(TEAM, () => insertDrafts("maps", lote, [{ nome: "Lead", telefone: num(50) }]));
    await expect(
      runWithTeam(TEAM, () => marcarTemWhatsAppDoLote(lote), { userId: "leitor", role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(chamadasEvo).toHaveLength(0);
    expect((await extrasDoLote(TEAM, lote)).Lead).toBeNull();

    expect(await runAsSystem(TEAM, () => marcarTemWhatsAppDoLote(lote))).toMatchObject({ verificados: 1, comWhatsApp: 1 });
    expect((await extrasDoLote(TEAM, lote)).Lead).toEqual({ temWhatsApp: true });
  });

  it("checagem que falha não derruba a captura (a fila fica sem a marca)", async () => {
    await contaWhatsApp(TEAM);
    fetchEvolution.mockImplementationOnce(async () => {
      throw new Error("Evolution fora");
    });
    const job = jobMaps(TEAM);
    const st = await executarCaptura(job, coletorCom([{ nome: "Lead", telefone: num(30) }]));
    expect(st).toMatchObject({ estado: "concluida", criados: 1 });
    // Evolution fora → "não deu para saber" (null), como na campanha.
    expect((await extrasDoLote(TEAM, job.lote)).Lead).toEqual({ temWhatsApp: null });
  });
});

describe("produtor rural na fila de CNPJ (H.3) e filtros do listDrafts (H.6)", () => {
  const cnpjExtra = (cnae: string | null, ies: { tipo: string; habilitada: boolean }[] = []) => ({
    cnpj: "00000000000100",
    razaoSocial: "Empresa Teste",
    nomeFantasia: null,
    nomeSocio: null,
    cnae,
    cnaeDescricao: "desc",
    cnaesSecundarios: [],
    ies,
    fonte: "cnpja",
    parcial: false,
  });

  it("classifica pelos CNAEs/IEs só na origem cnpj e expõe no DTO; filtros por WhatsApp e produtor; dois times", async () => {
    const lote = randomUUID();
    await runWithTeam(TEAM, () =>
      insertDrafts("cnpj", lote, [
        { nome: "Soja", telefone: num(40), extra: cnpjExtra("0115-6/00", [{ tipo: "Produtor Rural", habilitada: true }]) },
        { nome: "Atacado", telefone: num(41), extra: cnpjExtra("4623-1/99") },
        { nome: "Mercado", telefone: num(42), extra: cnpjExtra("4711-3/02") },
        { nome: "Sem CNAE", extra: cnpjExtra(null) },
      ]),
    );
    await runWithTeam(TEAM, () => insertDrafts("maps", lote, [{ nome: "Maps", telefone: num(43), extra: { cnae: "0115-6/00" } }]));
    const ex = await extrasDoLote(TEAM, lote);
    expect(ex.Soja).toMatchObject({ produtorLabel: "produtor", produtorScore: 85, fonte: "cnpja" });
    expect(ex.Atacado).toMatchObject({ produtorLabel: "provavel_produtor" });
    expect(ex.Mercado).toMatchObject({ produtorLabel: "nao_produtor", produtorScore: 0 });
    expect(ex["Sem CNAE"]).not.toHaveProperty("produtorLabel");
    expect(ex.Maps).not.toHaveProperty("produtorLabel");

    // Marca de WhatsApp como o worker faria (via captura), para exercitar o filtro.
    await basePrisma.whatsAppNumberCheck.createMany({
      data: [
        { numero: num(40), existe: true },
        { numero: num(41), existe: false },
        { numero: num(42), existe: true },
      ],
    });
    await executarCaptura({ origem: "cnpj", teamId: TEAM, lote, cnpjs: [] }, coletorCom([]));
    // O outro time tem um rascunho "produtor com WhatsApp" que nunca aparece para o TEAM.
    await runWithTeam(OUTRO, () => insertDrafts("cnpj", randomUUID(), [{ nome: "Alheio", extra: { ...cnpjExtra("0115-6/00"), temWhatsApp: true } }]));

    const nomes = async (input: Parameters<typeof listDrafts>[0]) =>
      (await runWithTeam(TEAM, () => listDrafts(input))).map((d) => d.nome).sort();

    expect(await nomes({ lote, temWhatsApp: true })).toEqual(["Mercado", "Soja"]);
    expect(await nomes({ lote, temWhatsApp: false })).toEqual(["Atacado"]);
    expect(await nomes({ produtorLabel: "produtor" })).toEqual(["Soja"]);
    expect(await nomes({ produtorLabel: ["produtor", "provavel_produtor"] })).toEqual(["Atacado", "Soja"]);
    expect(await nomes({ temWhatsApp: true, produtorLabel: "nao_produtor" })).toEqual(["Mercado"]);
    expect(await nomes({ lote })).toEqual(["Atacado", "Maps", "Mercado", "Sem CNAE", "Soja"]);

    const soja = (await runWithTeam(TEAM, () => listDrafts({ lote }))).find((d) => d.nome === "Soja")!;
    expect(soja).toMatchObject({ temWhatsApp: true, produtorLabel: "produtor", produtorScore: 85, avaliacao: null, avaliacoes: null, bio: null });
  });

  it("DTO tolera extra ausente, fora do formato ou com tipo errado", () => {
    const vazio = { temWhatsApp: null, produtorLabel: null, produtorScore: null, avaliacao: null, avaliacoes: null, bio: null };
    expect(extrasDoRascunho(null)).toEqual(vazio);
    expect(extrasDoRascunho([1, 2])).toEqual(vazio);
    expect(extrasDoRascunho({ temWhatsApp: "sim", produtorLabel: "talvez", avaliacao: 4.5, bio: "oi", username: "x" })).toEqual({
      ...vazio,
      avaliacao: 4.5,
      bio: "oi",
    });
  });
});
