import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { basePrisma } from "@crmagro/db";
import { CnpjLookupFailed, type PaginaDeBusca, type RegistroMinhaReceita } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";

// Fila `capture` mockada: só registra o que foi enfileirado.
const adicionados: { nome: string; data: Record<string, unknown>; opts: { jobId?: string } }[] = [];
vi.mock("bullmq", () => ({
  Queue: class {
    async add(nome: string, data: Record<string, unknown>, opts: { jobId?: string }) {
      adicionados.push({ nome, data, opts });
    }
  },
}));

// A checagem de "tem WhatsApp?" é contada (nunca vai à Evolution).
const marcarWhats = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./extras", async (original) => ({ ...(await original<typeof import("./extras")>()), marcarTemWhatsAppDoLote: marcarWhats }));

import {
  BUSCA_CNAES_MAX,
  BuscaSemContinuacao,
  FiltroInvalido,
  captureCnpjsPorFiltro,
  coletarPorFiltro,
  continuarBuscaPorFiltro,
  CapturaFalhou,
  executarCaptura,
  lerStatusCaptura,
  mesclarDetalhe,
  municipiosDaUf,
  normalizarCnae,
  normalizarFiltros,
  lidasMaxDaBusca,
  resolverMunicipios,
  statusDaCapturaAtual,
  coletarLoteCnpj,
  type CaptureJob,
} from "./index";

/**
 * Busca de empresas por filtro (aba "Por filtros"): validação pura, resolução de cidade, job na
 * fila, coletor com a FONTE FALSA (nada vai à Minha Receita, nem à OpenCNPJ) e as regras de
 * segurança (papel, outro time, outra pessoa, o cursor não vai para a tela).
 */
const TEAM = "00000000-0000-0000-0000-0000000005b1";
const OUTRO = "00000000-0000-0000-0000-0000000005b2";
const COD_CIDADE = 9_999_001; // município inventado só para o teste
const membro = (userId: string) => ({ userId, role: "member" });

type JobFiltro = Extract<CaptureJob, { origem: "cnpj"; modo: "filtro" }>;

let seq = 0;
const cnpjFalso = () => `7${String(++seq).padStart(13, "0")}`;
const registro = (o: Partial<RegistroMinhaReceita> = {}): RegistroMinhaReceita => ({
  cnpj: cnpjFalso(),
  razao_social: `EMPRESA ${seq}`,
  situacao_cadastral: 2,
  descricao_situacao_cadastral: "ATIVA",
  cnae_fiscal: 115600,
  cnae_fiscal_descricao: "Cultivo de soja",
  municipio: "CIDADE TESTE FILTRO",
  uf: "MT",
  ddd_telefone_1: "6635441234",
  porte: "DEMAIS",
  capital_social: 100000,
  codigo_natureza_juridica: 2062,
  data_inicio_atividade: "2018-01-01",
  qsa: [{ nome_socio: `SOCIA ${seq}`, qualificacao_socio: "Sócio" }],
  ...o,
});

/** Fonte falsa paginada: devolve `paginas[i]`, com cursor "p<i+1>" até a última. */
function fonteFalsa(paginas: RegistroMinhaReceita[][]) {
  const pedidos: (string | null)[] = [];
  const buscarPagina = vi.fn(async (_f: unknown, cursor: string | null): Promise<PaginaDeBusca> => {
    pedidos.push(cursor);
    const i = cursor ? Number(cursor.slice(1)) : 0;
    return { registros: paginas[i] ?? [], cursor: i + 1 < paginas.length ? `p${i + 1}` : null };
  });
  return { buscarPagina, pedidos };
}

const filtrosDoJob = (locais: Partial<JobFiltro["filtros"]["locais"]> = {}): JobFiltro["filtros"] => ({
  fonte: { cnaes: ["0115600"], ufs: ["MT"], municipios: [] },
  locais: { soAtivas: true, excluirPessoa: true, portes: [], capitalMin: null, capitalMax: null, abertaDesde: null, abertaAte: null, soComTelefone: false, ...locais },
  cidades: [],
});

function jobFiltro(o: Partial<JobFiltro> = {}): JobFiltro {
  return {
    origem: "cnpj",
    modo: "filtro",
    teamId: TEAM,
    lote: crypto.randomUUID(),
    ownerId: "ana",
    limite: 100,
    filtros: filtrosDoJob(),
    completarContato: false,
    checarWhatsApp: false,
    ...o,
  };
}

const sem = { pausaPaginaMs: 0, pausaConsultaMs: 0, esperaErroMs: 0 };
const rascunhos = (teamId: string, lote: string) => basePrisma.prospectDraft.findMany({ where: { teamId, lote } });

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Busca A (test)"], [OUTRO, "Team Busca B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await basePrisma.municipio.deleteMany({ where: { codigoIbge: COD_CIDADE } });
  await basePrisma.municipio.create({
    data: { codigoIbge: COD_CIDADE, nome: "Cidade Teste Filtro", nomeBusca: "cidade teste filtro", uf: "MT", latitude: -12, longitude: -55 },
  });
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});

afterAll(async () => {
  await basePrisma.municipio.deleteMany({ where: { codigoIbge: COD_CIDADE } });
});

beforeEach(async () => {
  adicionados.length = 0;
  marcarWhats.mockClear();
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
});

describe("normalizarFiltros (puro)", () => {
  it("CNAE em qualquer formato vira 7 dígitos; sem repetição", () => {
    expect(normalizarCnae("0115-6/00")).toBe("0115600");
    expect(normalizarCnae("115600")).toBe("0115600");
    expect(normalizarCnae("abc")).toBeNull();
    expect(normalizarCnae("12345678")).toBeNull();
    const f = normalizarFiltros({ cnaes: ["0115-6/00", "0115600", "4683-4/00"], ufs: ["mt"] });
    expect(f.cnaes).toEqual(["0115600", "4683400"]);
    expect(f.ufs).toEqual(["MT"]);
  });

  it("padrões seguros: só ativas, sem empresário individual/MEI, sem checar WhatsApp, 100 empresas", () => {
    const f = normalizarFiltros({ cnaes: ["0115600"] });
    expect(f.locais).toMatchObject({ soAtivas: true, excluirPessoa: true, soComTelefone: false });
    expect(f.checarWhatsApp).toBe(false);
    expect(f.completarContato).toBe(false);
    expect(f.limite).toBe(100);
  });

  it("recusa o que não dá para buscar, com frase pronta para a tela", () => {
    expect(() => normalizarFiltros({})).toThrow(FiltroInvalido);
    expect(() => normalizarFiltros({ cnaes: ["xx"] })).toThrow(/CNAE "xx" inválido/);
    expect(() => normalizarFiltros({ ufs: ["ZZ"] })).toThrow(/Estado "ZZ" inválido/);
    expect(() => normalizarFiltros({ cidades: ["Sorriso"] })).toThrow(/único estado/);
    expect(() => normalizarFiltros({ cidades: ["Sorriso"], ufs: ["MT", "GO"] })).toThrow(/único estado/);
    expect(() => normalizarFiltros({ ufs: ["MT"], capitalMin: 10, capitalMax: 5 })).toThrow(/capital social mínimo/);
    expect(() => normalizarFiltros({ ufs: ["MT"], abertaDesde: "2020-01-01", abertaAte: "2019-01-01" })).toThrow(/data de abertura/);
    expect(() => normalizarFiltros({ ufs: ["MT"], limite: 501 })).toThrow(FiltroInvalido);
    expect(() => normalizarFiltros({ ufs: ["MT"], limite: 0 })).toThrow(FiltroInvalido);
    const muitos = Array.from({ length: BUSCA_CNAES_MAX + 1 }, (_, i) => `011130${i}`);
    expect(() => normalizarFiltros({ cnaes: muitos })).toThrow(FiltroInvalido);
  });
});

describe("resolverMunicipios (tabela Municipio, dado público)", () => {
  it("nome sem acento e em qualquer caixa vira o código IBGE; nome que não existe é recusado", async () => {
    expect(await resolverMunicipios(["CIDADE teste  filtro"], "MT")).toEqual({ codigos: [COD_CIDADE], rotulos: ["Cidade Teste Filtro/MT"] });
    await expect(resolverMunicipios(["Cidade Que Nao Existe"], "MT")).rejects.toThrow(/Não achei a cidade/);
    await expect(resolverMunicipios(["Cidade Teste Filtro"], "GO")).rejects.toBeInstanceOf(FiltroInvalido); // outro estado
    expect(await resolverMunicipios([], null)).toEqual({ codigos: [], rotulos: [] });
    expect((await municipiosDaUf("mt")).some((m) => m.codigo === COD_CIDADE)).toBe(true);
    expect(await municipiosDaUf("XX")).toEqual([]);
  });
});

describe("captureCnpjsPorFiltro (vai para a fila, não cria contato)", () => {
  it("enfileira o job com os filtros resolvidos, o dono e o status 'na fila'", async () => {
    const r = await runWithTeam(TEAM, () =>
      captureCnpjsPorFiltro({ cnaes: ["0115-6/00"], ufs: ["MT"], cidades: ["Cidade Teste Filtro"], limite: 250, portes: ["micro"] }),
      membro("ana"),
    );
    expect(adicionados).toHaveLength(1);
    expect(adicionados[0]!.opts.jobId).toBe(`captura_${r.lote}`);
    expect(adicionados[0]!.data).toMatchObject({
      origem: "cnpj",
      modo: "filtro",
      teamId: TEAM,
      lote: r.lote,
      ownerId: "ana",
      limite: 250,
      completarContato: false,
      checarWhatsApp: false,
      filtros: {
        fonte: { cnaes: ["0115600"], ufs: ["MT"], municipios: [COD_CIDADE] },
        locais: { soAtivas: true, excluirPessoa: true, portes: ["micro"] },
        cidades: ["Cidade Teste Filtro/MT"],
      },
    });
    expect(await runWithTeam(TEAM, () => statusDaCapturaAtual(r.lote), membro("ana"))).toMatchObject({ estado: "na_fila", total: 250, origem: "cnpj" });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("filtro inválido não enfileira nada; só leitura (viewer) não busca", async () => {
    await expect(runWithTeam(TEAM, () => captureCnpjsPorFiltro({}), membro("ana"))).rejects.toBeInstanceOf(FiltroInvalido);
    await expect(runWithTeam(TEAM, () => captureCnpjsPorFiltro({ cnaes: ["0115600"] }), { userId: "v", role: "viewer" })).rejects.toThrow();
    expect(adicionados).toHaveLength(0);
  });
});

describe("coletarPorFiltro (fonte falsa)", () => {
  it("lê as páginas, aplica os filtros locais e grava só o que passa, com a origem da busca", async () => {
    const boas = [registro(), registro(), registro()];
    const ruins = [
      registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" }),
      registro({ codigo_natureza_juridica: 2135 }), // empresário individual
      registro({ opcao_pelo_mei: true }), // MEI
    ];
    const { buscarPagina } = fonteFalsa([[boas[0]!, ruins[0]!, boas[1]!], [ruins[1]!, ruins[2]!, boas[2]!]]);
    const job = jobFiltro();
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 3, total: 100, processados: 3 });
    const rs = await rascunhos(TEAM, job.lote);
    expect(rs.map((r) => r.cnpj).sort()).toEqual(boas.map((b) => b.cnpj!).sort());
    for (const r of rs) {
      expect(r).toMatchObject({ origem: "cnpj", ownerId: "ana", status: "pendente", telefone: "(66) 3544-1234", email: null });
      expect(r.extra).toMatchObject({ fonte: "minhareceita", parcial: true, modo: "filtro", cnaes: ["0115600"], ufs: ["MT"] });
    }
    // Chegou ao fim da fonte: nada a continuar.
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toBeNull();
    // A checagem de WhatsApp fica DESLIGADA por padrão nessa busca (gasta a cota do número).
    expect(marcarWhats).not.toHaveBeenCalled();
  });

  it("checarWhatsApp ligado checa; a lista de CNPJ continua checando sempre", async () => {
    const { buscarPagina } = fonteFalsa([[registro()]]);
    const ligado = jobFiltro({ checarWhatsApp: true });
    await executarCaptura(ligado, coletarPorFiltro(ligado, { ...sem, buscarPagina }));
    expect(marcarWhats).toHaveBeenCalledTimes(1);

    marcarWhats.mockClear();
    const lista: CaptureJob = { origem: "cnpj", teamId: TEAM, lote: crypto.randomUUID(), cnpjs: [] };
    await executarCaptura(lista, coletarLoteCnpj([], { pausaMs: 0 })).catch(() => undefined);
    expect(marcarWhats).toHaveBeenCalledTimes(1);
  });

  it("para no limite NO MEIO da página e 'Buscar mais' continua do registro seguinte, sem repetir nem pular", async () => {
    const todas = Array.from({ length: 7 }, () => registro());
    const paginas = [todas.slice(0, 3), todas.slice(3, 6), todas.slice(6)];
    const f1 = fonteFalsa(paginas);
    const job1 = jobFiltro({ limite: 4 });
    const st1 = await executarCaptura(job1, coletarPorFiltro(job1, { ...sem, buscarPagina: f1.buscarPagina }));
    expect(st1).toMatchObject({ estado: "concluida", criados: 4 });
    expect((await rascunhos(TEAM, job1.lote)).map((r) => r.cnpj).sort()).toEqual(todas.slice(0, 4).map((r) => r.cnpj!).sort());
    const c1 = (await lerStatusCaptura(TEAM, job1.lote))?.continuacao;
    expect(c1).toMatchObject({ cursor: "p1", saltar: 1, lidasNaFonte: 4 }); // parou no 2º registro da 2ª página

    const f2 = fonteFalsa(paginas);
    const job2 = jobFiltro({ limite: 10, cursor: c1!.cursor, saltar: c1!.saltar, lidasAntes: c1!.lidasNaFonte });
    const st2 = await executarCaptura(job2, coletarPorFiltro(job2, { ...sem, buscarPagina: f2.buscarPagina }));
    expect(st2).toMatchObject({ estado: "concluida", criados: 3 });
    expect(f2.pedidos).toEqual(["p1", "p2"]); // recomeçou da página onde parou
    expect((await rascunhos(TEAM, job2.lote)).map((r) => r.cnpj).sort()).toEqual(todas.slice(4).map((r) => r.cnpj!).sort());
    expect((await lerStatusCaptura(TEAM, job2.lote))?.continuacao).toBeNull();
  });

  it("limite que cai exatamente no fim de uma página continua na próxima", async () => {
    const paginas = [[registro(), registro()], [registro()]];
    const f = fonteFalsa(paginas);
    const job = jobFiltro({ limite: 2 });
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toMatchObject({ cursor: "p1", saltar: 0 });
  });

  it("completarContato: usa a consulta do CNPJ (e-mail, sócios) e, se ela falhar, fica com o que a busca trouxe", async () => {
    const [a, b] = [registro(), registro()];
    const { buscarPagina } = fonteFalsa([[a, b]]);
    const consultar = vi.fn(async (cnpj: string) => {
      if (cnpj === b.cnpj) throw new CnpjLookupFailed(cnpj, "fora do ar");
      const base = resultadoMinimo(cnpj);
      return { resultado: base, origem: "opencnpj" as const };
    });
    const job = jobFiltro({ completarContato: true });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina, consultar }));
    expect(st).toMatchObject({ estado: "concluida", criados: 2, falhas: 0 });
    const rs = await rascunhos(TEAM, job.lote);
    const ra = rs.find((r) => r.cnpj === a.cnpj)!;
    const rb = rs.find((r) => r.cnpj === b.cnpj)!;
    expect(ra).toMatchObject({ email: "contato@exemplo.test", telefone: "(66) 3544-1234" }); // e-mail veio da consulta, telefone da busca
    expect(rb).toMatchObject({ email: null, telefone: "(66) 3544-1234" });
  });

  it("primeira página falha: a busca falha visível; falha depois de gravar algo: parcial com 'Buscar mais'", async () => {
    const job = jobFiltro();
    const quebra = vi.fn(async () => { throw new CnpjLookupFailed("busca", "HTTP 503"); });
    await expect(executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: quebra }))).rejects.toThrow(/HTTP 503/);
    expect(await lerStatusCaptura(TEAM, job.lote)).toMatchObject({ estado: "falhou", motivo: "erro", criados: 0 });

    const job2 = jobFiltro();
    let n = 0;
    const meio = vi.fn(async (): Promise<PaginaDeBusca> => {
      if (n++ === 0) return { registros: [registro()], cursor: "p1" };
      throw new CnpjLookupFailed("busca", "tempo esgotado (30s)");
    });
    const st = await executarCaptura(job2, coletarPorFiltro(job2, { ...sem, buscarPagina: meio }));
    expect(st).toMatchObject({ estado: "parcial", motivo: "erro", criados: 1 });
    expect((await lerStatusCaptura(TEAM, job2.lote))?.continuacao).toMatchObject({ cursor: "p1", saltar: 0 });
  });

  it("leu muito e quase nada passou: encerra com o motivo certo e deixa continuar", async () => {
    // Páginas só de empresas baixadas: nenhuma passa. Teto de leitura = 4.
    const pagina = () => [registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" }), registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" })];
    const f = fonteFalsa([pagina(), pagina(), pagina(), pagina()]);
    const job = jobFiltro();
    await expect(executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, lidasMax: 4 }))).rejects.toBeInstanceOf(CapturaFalhou);
    expect(await lerStatusCaptura(TEAM, job.lote)).toMatchObject({ estado: "falhou", motivo: "filtros_apertados" });
    expect(f.pedidos).toHaveLength(2);
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toMatchObject({ cursor: "p2", lidasNaFonte: 4 });
  });

  it("teto de tempo: para com o que já veio (parcial) e guarda onde parou", async () => {
    const f = fonteFalsa([[registro()], [registro()], [registro()]]);
    const tempos = [0, 0, 60 * 60_000];
    const agora = () => tempos.shift() ?? 60 * 60_000;
    const job = jobFiltro();
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, tetoMs: 20 * 60_000, agora }));
    expect(st).toMatchObject({ estado: "parcial", motivo: "tempo_esgotado", criados: 1 });
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toMatchObject({ cursor: "p1" });
  });

  it("nada passa nos filtros e a fonte acabou: 'vazia', sem continuação", async () => {
    const { buscarPagina } = fonteFalsa([[registro({ codigo_natureza_juridica: 2135 })]]);
    const job = jobFiltro();
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina }));
    expect(st).toMatchObject({ estado: "vazia", motivo: "sem_resultados", criados: 0 });
  });

  it("mesmo CNPJ repetido na fonte entra uma vez só", async () => {
    const r = registro();
    const { buscarPagina } = fonteFalsa([[r, { ...r }]]);
    const job = jobFiltro();
    expect(await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina }))).toMatchObject({ criados: 1 });
  });
});

describe("mesclarDetalhe", () => {
  it("o detalhe manda, mas não apaga o que só a busca tinha", () => {
    const busca = { ...resultadoMinimo("1"), email: null, telefone: "(66) 1111-1111", socios: [] } as never;
    const detalhe = { ...resultadoMinimo("1"), telefone: null, socios: [{ nome: "X", qualificacao: null }] } as never;
    expect(mesclarDetalhe(detalhe, busca)).toMatchObject({ email: "contato@exemplo.test", telefone: "(66) 1111-1111", socios: [{ nome: "X", qualificacao: null }] });
  });
});

describe("segurança: 'Buscar mais' e o status", () => {
  async function buscaDe(userId: string, teamId = TEAM) {
    const todas = Array.from({ length: 5 }, () => registro());
    const f = fonteFalsa([todas.slice(0, 3), todas.slice(3)]);
    const job = jobFiltro({ teamId, limite: 2, ownerId: userId });
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    return job.lote;
  }

  it("a tela recebe 'podeContinuar', nunca o cursor nem os filtros; o servidor guarda a continuação", async () => {
    const lote = await buscaDe("ana");
    const paraATela = await runWithTeam(TEAM, () => statusDaCapturaAtual(lote), membro("ana"));
    expect(paraATela).toMatchObject({ estado: "concluida", podeContinuar: true });
    expect(paraATela).not.toHaveProperty("continuacao");
    expect(JSON.stringify(paraATela)).not.toContain("p1");
    expect((await lerStatusCaptura(TEAM, lote))?.continuacao).toBeTruthy();
  });

  it("quem fez a busca continua: novo lote com os MESMOS filtros e o cursor guardado", async () => {
    const lote = await buscaDe("ana");
    const r = await runWithTeam(TEAM, () => continuarBuscaPorFiltro(lote, 50), membro("ana"));
    expect(r.lote).not.toBe(lote);
    expect(adicionados).toHaveLength(1);
    expect(adicionados[0]!.data).toMatchObject({ origem: "cnpj", modo: "filtro", teamId: TEAM, lote: r.lote, ownerId: "ana", limite: 50, cursor: null, saltar: 2, lidasAntes: 2, completarContato: false, checarWhatsApp: false });
    expect(adicionados[0]!.data.filtros).toMatchObject({ fonte: { cnaes: ["0115600"], ufs: ["MT"] } });
  });

  it("OUTRO time não continua o lote (a continuação é por time)", async () => {
    const lote = await buscaDe("ana");
    await expect(runWithTeam(OUTRO, () => continuarBuscaPorFiltro(lote, 50), membro("ana"))).rejects.toBeInstanceOf(BuscaSemContinuacao);
    expect(adicionados).toHaveLength(0);
  });

  it("OUTRO membro do mesmo time não continua a busca da Ana; o dono do time continua", async () => {
    const lote = await buscaDe("ana");
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro(lote, 50), membro("beto"))).rejects.toBeInstanceOf(BuscaSemContinuacao);
    expect(adicionados).toHaveLength(0);
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro(lote, 50), { userId: "dono", role: "owner" })).resolves.toBeTruthy();
  });

  it("lote sem continuação, lote inventado e viewer são recusados", async () => {
    const f = fonteFalsa([[registro()]]);
    const job = jobFiltro();
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro(job.lote, 50), membro("ana"))).rejects.toBeInstanceOf(BuscaSemContinuacao); // fonte acabou
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro(crypto.randomUUID(), 50), membro("ana"))).rejects.toBeInstanceOf(BuscaSemContinuacao);
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro("*", 50), membro("ana"))).rejects.toBeInstanceOf(BuscaSemContinuacao);
    const lote = await buscaDe("ana");
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro(lote, 50), { userId: "v", role: "viewer" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Busca com UM clique: laço até a quantidade, já cadastradas, cidades, secundário, e-mail
// ---------------------------------------------------------------------------

describe("normalizarFiltros: opções novas", () => {
  it("padrões: sem já cadastradas, só CNAE principal, ignora contabilidade, sem filtro de e-mail", () => {
    const f = normalizarFiltros({ cnaes: ["0115600"] });
    expect(f.opcoes).toEqual({ incluirJaCadastradas: false, ignorarEmailContabilidade: true, soComEmail: false, emailDominio: [] });
    expect(f.locais.cnaesPrincipais).toEqual(["0115600"]);
    expect(f.completarContato).toBe(false);
  });

  it("'Considerar CNAE secundário' ligado tira a exigência do principal", () => {
    expect(normalizarFiltros({ cnaes: ["0115600"], cnaeSecundario: true }).locais.cnaesPrincipais).toEqual([]);
  });

  it("palavra do domínio: caixa desmarcada com texto é ignorada", () => {
    const f = normalizarFiltros({ cnaes: ["0115600"], emailDominioAtivo: false, emailDominio: "grupo" });
    expect(f.opcoes).toMatchObject({ emailDominio: [], soComEmail: false });
    expect(f.completarContato).toBe(false);
  });

  it("palavra do domínio: marcada e vazia não filtra nada e não liga 'Só com e-mail'", () => {
    for (const texto of ["", " ", "@", ","]) {
      const f = normalizarFiltros({ cnaes: ["0115600"], emailDominioAtivo: true, emailDominio: texto });
      expect(f.opcoes).toMatchObject({ emailDominio: [], soComEmail: false });
      expect(f.completarContato).toBe(false);
    }
  });

  it("palavra do domínio: marcada com palavra vale, implica 'Só com e-mail' e a consulta de cada empresa", () => {
    const f = normalizarFiltros({ cnaes: ["0115600"], emailDominioAtivo: true, emailDominio: "@Grupo, Agrícola" });
    expect(f.opcoes).toMatchObject({ emailDominio: ["grupo", "agricola"], soComEmail: true });
    expect(f.completarContato).toBe(true);
  });

  it("aceita várias cidades (até o teto) num só estado", () => {
    expect(() => normalizarFiltros({ ufs: ["MT"], cidades: ["Sorriso", "Sinop", "Lucas do Rio Verde"] })).not.toThrow();
    expect(() => normalizarFiltros({ ufs: ["MT"], cidades: Array.from({ length: 21 }, (_, i) => `Cidade ${i}`) })).toThrow(FiltroInvalido);
  });

  it("o teto de leitura cresce com a quantidade pedida, entre 5.000 e 20.000", () => {
    expect(lidasMaxDaBusca(100)).toBe(5_000);
    expect(lidasMaxDaBusca(200)).toBe(8_000);
    expect(lidasMaxDaBusca(500)).toBe(20_000);
  });
});

describe("várias cidades: a busca percorre todas e a quantidade vale para o total", () => {
  const COD2 = 9_999_002;
  beforeAll(async () => {
    await basePrisma.municipio.deleteMany({ where: { codigoIbge: COD2 } });
    await basePrisma.municipio.create({ data: { codigoIbge: COD2, nome: "Outra Cidade Filtro", nomeBusca: "outra cidade filtro", uf: "MT", latitude: -12, longitude: -55 } });
  });
  afterAll(async () => {
    await basePrisma.municipio.deleteMany({ where: { codigoIbge: COD2 } });
  });

  it("todas as cidades escolhidas viram códigos IBGE no mesmo job, e o limite é um só", async () => {
    const r = await runWithTeam(
      TEAM,
      () => captureCnpjsPorFiltro({ cnaes: ["0115600"], ufs: ["MT"], cidades: ["Cidade Teste Filtro", "outra cidade filtro"], limite: 200 }),
      membro("ana"),
    );
    const job = adicionados.find((a) => (a.data as { lote?: string }).lote === r.lote)!.data as unknown as JobFiltro;
    expect(job.limite).toBe(200);
    expect(job.filtros.fonte.municipios).toEqual([COD_CIDADE, COD2]);
    expect(job.filtros.cidades).toEqual(["Cidade Teste Filtro/MT", "Outra Cidade Filtro/MT"]);
  });

  it("cidade que não existe no estado é recusada com o nome", async () => {
    await expect(runWithTeam(TEAM, () => captureCnpjsPorFiltro({ ufs: ["MT"], cidades: ["Cidade Teste Filtro", "Lugar Nenhum"] }), membro("ana"))).rejects.toThrow(/Lugar Nenhum/);
  });
});

describe("coletarPorFiltro: um clique até a quantidade pedida", () => {
  const opcoesNovas = { incluirJaCadastradas: false, ignorarEmailContabilidade: true, soComEmail: false, emailDominio: [] as string[] };
  const jobNovo = (o: Partial<JobFiltro> = {}, opcoes: Partial<typeof opcoesNovas> = {}, locais: Partial<JobFiltro["filtros"]["locais"]> = {}) =>
    jobFiltro({ ...o, filtros: { ...filtrosDoJob(locais), opcoes: { ...opcoesNovas, ...opcoes } } });
  const limpar = async () => {
    await basePrisma.contactCompany.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
    await basePrisma.company.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
    await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  };
  beforeEach(limpar);
  afterAll(limpar);

  it("continua lendo páginas sozinho (descartadas por filtro) até juntar a quantidade, em UM job", async () => {
    // 6 páginas de 5: só 2 de cada 5 passam (3 são baixadas). Pedido: 10.
    const pagina = () => [registro(), registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" }), registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" }), registro(), registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" })];
    const f = fonteFalsa(Array.from({ length: 6 }, pagina));
    const job = jobNovo({ limite: 10 });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 10, processados: 10, total: 10 });
    expect(f.pedidos).toHaveLength(5); // parou na 5ª página, sem precisar de outro clique
    expect(st.motivo).toBeNull(); // não esgotou a fonte
    expect((await rascunhos(TEAM, job.lote))).toHaveLength(10);
  });

  it("grava aos poucos: o progresso passa por valores intermediários antes de chegar à quantidade", async () => {
    const f = fonteFalsa([Array.from({ length: 25 }, () => registro())]);
    const job = jobNovo({ limite: 25 });
    const vistos: number[] = [];
    const st = await executarCaptura(job, async (ctx) => {
      const ctx2 = { ...ctx, progresso: (n: number) => { vistos.push(n); ctx.progresso(n); } };
      return coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina })(ctx2);
    });
    expect(st.criados).toBe(25);
    expect(vistos).toEqual(expect.arrayContaining([10, 20, 25])); // lotes de 10, e o resto no fim
  });

  it("a fonte acabou antes da quantidade: conclui avisando quantas havia", async () => {
    const f = fonteFalsa([[registro(), registro()], [registro()]]);
    const job = jobNovo({ limite: 200 });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 3, motivo: "fonte_esgotada" });
    expect(st.mensagem).toBe("Só havia 3 empresas com esses filtros. A fonte não tem mais.");
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toBeNull();
  });

  it("quantidade atingida bem no fim da fonte NÃO conta como esgotada", async () => {
    const f = fonteFalsa([[registro(), registro()]]);
    const job = jobNovo({ limite: 2 });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 2 });
    expect(st.motivo).toBeNull();
  });

  it("falha passageira da fonte: tenta de novo e segue, sem parar a busca", async () => {
    let n = 0;
    const buscarPagina = vi.fn(async (): Promise<PaginaDeBusca> => {
      if (n++ === 0) throw new CnpjLookupFailed("busca", "HTTP 503");
      return { registros: [registro(), registro()], cursor: null };
    });
    const job = jobNovo({ limite: 5 });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 2 });
    expect(buscarPagina).toHaveBeenCalledTimes(2);
  });

  it("'Parar': para entre as páginas, o que veio fica na fila e dá para continuar", async () => {
    const f = fonteFalsa([[registro(), registro()], [registro()], [registro()]]);
    let pedidos = 0;
    const parar = async () => ++pedidos > 1; // deixa a 1ª página passar
    const job = jobNovo({ limite: 50 });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, parar }));
    expect(st).toMatchObject({ estado: "parcial", motivo: "parada_pelo_usuario", criados: 2 });
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toMatchObject({ cursor: "p1", saltar: 0 });
  });

  it("'Parar' antes de qualquer empresa: não é falha (não derruba o job)", async () => {
    const f = fonteFalsa([[registro()]]);
    const job = jobNovo({ limite: 5 });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, parar: async () => true }));
    expect(st).toMatchObject({ estado: "interrompida", motivo: "parada_pelo_usuario", criados: 0 });
    expect(f.pedidos).toHaveLength(0);
  });

  it("o teto de leitura cresce com o pedido: 200 empresas leem além de 5.000 se for preciso", async () => {
    // Teto de leitura explícito baixo para o teste: com o teto, para e deixa continuar.
    const pagina = () => [registro({ situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" })];
    const f = fonteFalsa([pagina(), pagina(), pagina()]);
    const job = jobNovo({ limite: 5 });
    await expect(executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, lidasMax: 2 }))).rejects.toBeInstanceOf(CapturaFalhou);
    expect(await lerStatusCaptura(TEAM, job.lote)).toMatchObject({ motivo: "filtros_apertados" });
  });
});

describe("coletarPorFiltro: já cadastradas ficam fora ANTES de contar a quantidade", () => {
  const opc = (incluirJaCadastradas: boolean) => ({ incluirJaCadastradas, ignorarEmailContabilidade: true, soComEmail: false, emailDominio: [] as string[] });
  const jobCom = (incluir: boolean, limite: number) => jobFiltro({ limite, filtros: { ...filtrosDoJob(), opcoes: opc(incluir) } });
  const limpar = async () => {
    await basePrisma.contactCompany.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
    await basePrisma.company.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
    await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  };
  beforeEach(limpar);
  afterAll(limpar);

  async function cenario() {
    const [gravadaNoContato, deEmpresaLigada, doOutroTime, nova1, nova2, nova3] = [registro(), registro(), registro(), registro(), registro(), registro()];
    await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Dono A", cnpj: gravadaNoContato.cnpj! } });
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Dono B" } });
    const emp = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Empresa B", cnpj: deEmpresaLigada.cnpj! } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: c.id, companyId: emp.id } });
    await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Dono de Outro Time", cnpj: doOutroTime.cnpj! } });
    return { gravadaNoContato, deEmpresaLigada, doOutroTime, novas: [nova1, nova2, nova3] };
  }

  it("desligada (padrão): as cadastradas do time saem e 3 pedidas significam 3 NOVAS; outro time não conta", async () => {
    const { gravadaNoContato, deEmpresaLigada, doOutroTime, novas } = await cenario();
    const f = fonteFalsa([[gravadaNoContato, deEmpresaLigada, novas[0]!], [doOutroTime, novas[1]!, novas[2]!]]);
    const job = jobCom(false, 3);
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 3 });
    const cnpjs = (await rascunhos(TEAM, job.lote)).map((r) => r.cnpj).sort();
    // A do outro time aparece (para o time desta busca ela é nova); as duas cadastradas deste time, não.
    expect(cnpjs).toEqual([novas[0]!.cnpj, doOutroTime.cnpj, novas[1]!.cnpj].sort());
  });

  it("ligada: as cadastradas aparecem como antes e contam", async () => {
    const { gravadaNoContato, deEmpresaLigada, novas } = await cenario();
    const f = fonteFalsa([[gravadaNoContato, deEmpresaLigada, novas[0]!]]);
    const job = jobCom(true, 3);
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st).toMatchObject({ estado: "concluida", criados: 3 });
  });

  it("o CNPJ que já está na fila de revisão desta pessoa não entra de novo (nem conta)", async () => {
    const [repetida, nova] = [registro(), registro()];
    await basePrisma.prospectDraft.create({ data: { teamId: TEAM, origem: "cnpj", lote: "antigo", nome: "Já na fila", cnpj: repetida.cnpj!, ownerId: "ana", status: "pendente" } });
    const f = fonteFalsa([[repetida, nova]]);
    const job = jobCom(true, 5);
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st.criados).toBe(1);
    expect((await rascunhos(TEAM, job.lote)).map((r) => r.cnpj)).toEqual([nova.cnpj]);
  });

  it("a fila de OUTRA pessoa não bloqueia a minha", async () => {
    const r = registro();
    await basePrisma.prospectDraft.create({ data: { teamId: TEAM, origem: "cnpj", lote: "da-bia", nome: "Da Bia", cnpj: r.cnpj!, ownerId: "bia", status: "pendente" } });
    const f = fonteFalsa([[r]]);
    const job = jobCom(true, 5);
    expect((await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }))).criados).toBe(1);
  });
});

describe("coletarPorFiltro: CNAE secundário, telefone e e-mail", () => {
  const opcoes = (o: Partial<{ incluirJaCadastradas: boolean; ignorarEmailContabilidade: boolean; soComEmail: boolean; emailDominio: string[] }> = {}) => ({
    incluirJaCadastradas: true,
    ignorarEmailContabilidade: true,
    soComEmail: false,
    emailDominio: [] as string[],
    ...o,
  });
  const jobE = (o: Partial<JobFiltro>, op: ReturnType<typeof opcoes>, locais: Partial<JobFiltro["filtros"]["locais"]> = {}) =>
    jobFiltro({ ...o, filtros: { ...filtrosDoJob(locais), opcoes: op } });
  /** Consulta falsa: devolve os e-mails combinados por CNPJ. */
  const consultaCom = (porCnpj: Record<string, { email?: string | null; emails?: string[] }>) =>
    vi.fn(async (cnpj: string) => {
      const d = porCnpj[cnpj] ?? {};
      return { resultado: { ...resultadoMinimo(cnpj), email: d.email ?? null, emails: (d.emails ?? []).map((valor) => ({ valor, tipo: "desconhecido" as const })) } as never, origem: "cache" as const };
    });

  it("CNAE secundário: desligado só fica quem tem o CNAE como PRINCIPAL; ligado, o secundário também vale", async () => {
    const principal = registro({ cnae_fiscal: 115600 });
    const soSecundario = registro({ cnae_fiscal: 151201, cnaes_secundarios: [{ codigo: 115600, descricao: "Cultivo de soja" }] });
    const fonteSecundaria = () => fonteFalsa([[principal, soSecundario]]).buscarPagina;

    const desligado = jobE({ limite: 10 }, opcoes(), { cnaesPrincipais: ["0115600"] });
    await executarCaptura(desligado, coletarPorFiltro(desligado, { ...sem, buscarPagina: fonteSecundaria() }));
    expect((await rascunhos(TEAM, desligado.lote)).map((r) => r.cnpj)).toEqual([principal.cnpj]);

    await basePrisma.prospectDraft.deleteMany({ where: { teamId: TEAM } }); // as da 1ª busca ainda estariam na fila
    const ligado = jobE({ limite: 10 }, opcoes(), { cnaesPrincipais: [] });
    await executarCaptura(ligado, coletarPorFiltro(ligado, { ...sem, buscarPagina: fonteSecundaria() }));
    expect((await rascunhos(TEAM, ligado.lote)).map((r) => r.cnpj).sort()).toEqual([principal.cnpj!, soSecundario.cnpj!].sort());
  });

  it("só com telefone: sem telefone válido sai ANTES de contar a quantidade", async () => {
    const [semTel, curto, comTel1, comTel2] = [registro({ ddd_telefone_1: "" }), registro({ ddd_telefone_1: "12345" }), registro(), registro({ ddd_telefone_1: "", ddd_telefone_2: "66999887766" })];
    const f = fonteFalsa([[semTel, curto, comTel1, comTel2]]);
    const job = jobE({ limite: 2 }, opcoes(), { soComTelefone: true });
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina }));
    expect(st.criados).toBe(2);
    expect((await rascunhos(TEAM, job.lote)).map((r) => r.cnpj).sort()).toEqual([comTel1.cnpj!, comTel2.cnpj!].sort());
  });

  it("contabilidade exclui a EMPRESA (não conta na quantidade); contato@ fica; vale antes e depois do @", async () => {
    const [contab, depoisDoArroba, contCurto, contato, semEmail, boa] = [registro(), registro(), registro(), registro(), registro(), registro()];
    const consultar = consultaCom({
      [contab.cnpj!]: { email: "contabilidade@x.com" },
      [depoisDoArroba.cnpj!]: { email: "financeiro@escritoriocontabil.com.br" },
      [contCurto.cnpj!]: { email: "cont.sul@x.com.br" },
      [contato.cnpj!]: { email: "contato@empresa.com" },
      [boa.cnpj!]: { email: "vendas@boa.com" },
    });
    const f = fonteFalsa([[contab, depoisDoArroba, contCurto, contato, semEmail, boa]]);
    const job = jobE({ limite: 3, completarContato: true }, opcoes());
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar }));
    expect(st.criados).toBe(3);
    const rs = await rascunhos(TEAM, job.lote);
    expect(rs.map((r) => r.cnpj).sort()).toEqual([contato.cnpj!, semEmail.cnpj!, boa.cnpj!].sort());
    expect(rs.find((r) => r.cnpj === contato.cnpj)?.email).toBe("contato@empresa.com");
  });

  it("empresa com mais de um e-mail: sai se ALGUM for de contabilidade", async () => {
    const [mista, limpa] = [registro(), registro()];
    const consultar = consultaCom({
      [mista.cnpj!]: { email: "vendas@x.com", emails: ["vendas@x.com", "contab@escritorio.com"] },
      [limpa.cnpj!]: { email: "vendas@y.com", emails: ["vendas@y.com", "rh@y.com"] },
    });
    const f = fonteFalsa([[mista, limpa]]);
    const job = jobE({ limite: 5, completarContato: true }, opcoes());
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar }));
    expect((await rascunhos(TEAM, job.lote)).map((r) => r.cnpj)).toEqual([limpa.cnpj]);
  });

  it("com a opção de contabilidade DESLIGADA a empresa entra", async () => {
    const r = registro();
    const f = fonteFalsa([[r]]);
    const job = jobE({ limite: 5, completarContato: true }, opcoes({ ignorarEmailContabilidade: false }));
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar: consultaCom({ [r.cnpj!]: { email: "contabil@x.com" } }) }));
    expect((await rascunhos(TEAM, job.lote))).toHaveLength(1);
  });

  it("'Só com e-mail': empresa sem e-mail (ou com consulta que falhou) sai antes de contar", async () => {
    const [com, sem1, falha] = [registro(), registro(), registro()];
    const consultar = vi.fn(async (cnpj: string) => {
      if (cnpj === falha.cnpj) throw new CnpjLookupFailed(cnpj, "fora do ar");
      return { resultado: { ...resultadoMinimo(cnpj), email: cnpj === com.cnpj ? "a@x.com" : null } as never, origem: "cache" as const };
    });
    const f = fonteFalsa([[sem1, falha, com]]);
    const job = jobE({ limite: 1, completarContato: true }, opcoes({ soComEmail: true }));
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar }));
    expect(st.criados).toBe(1);
    expect((await rascunhos(TEAM, job.lote)).map((r) => r.cnpj)).toEqual([com.cnpj]);
  });

  it("palavra no domínio: casa o domínio, a parte antes do @ não casa; vários termos; sem acento", async () => {
    const [dominio, local, outro, acento] = [registro(), registro(), registro(), registro()];
    const consultar = consultaCom({
      [dominio.cnpj!]: { email: "contato@grupoabc.com.br" },
      [local.cnpj!]: { email: "grupo@gmail.com" },
      [outro.cnpj!]: { email: "oi@agricola.com" },
      [acento.cnpj!]: { email: "oi@agrícolasul.com.br" },
    });
    const f = fonteFalsa([[dominio, local, outro, acento]]);
    const job = jobE({ limite: 10, completarContato: true }, opcoes({ soComEmail: true, emailDominio: ["grupo", "agricola"] }));
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar }));
    expect((await rascunhos(TEAM, job.lote)).map((r) => r.cnpj).sort()).toEqual([dominio.cnpj!, outro.cnpj!, acento.cnpj!].sort());
  });

  it("palavra no domínio junto com contabilidade: o e-mail de contabilidade ainda tira a empresa", async () => {
    const r = registro();
    const f = fonteFalsa([[r]]);
    const job = jobE({ limite: 5, completarContato: true }, opcoes({ soComEmail: true, emailDominio: ["grupo"] }));
    await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar: consultaCom({ [r.cnpj!]: { email: "x@grupocontabil.com" } }) }));
    expect(await rascunhos(TEAM, job.lote)).toHaveLength(0);
  });

  it("consultas além do teto: para e deixa 'Buscar mais'", async () => {
    const todas = Array.from({ length: 6 }, () => registro());
    const f = fonteFalsa([todas]);
    const consultar = consultaCom(Object.fromEntries(todas.map((t) => [t.cnpj!, { email: "a@x.com" }])));
    const job = jobE({ limite: 6, completarContato: true }, opcoes());
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: f.buscarPagina, consultar, consultasMax: 3 }));
    expect(st).toMatchObject({ estado: "parcial", motivo: "filtros_apertados", criados: 3 });
    expect((await lerStatusCaptura(TEAM, job.lote))?.continuacao).toMatchObject({ cursor: null, saltar: 3, completarContato: true });
  });

  it("'Buscar mais' de uma busca com filtro de e-mail continua consultando cada empresa e com as mesmas opções", async () => {
    const lote = crypto.randomUUID();
    const filtros = { ...filtrosDoJob(), opcoes: opcoes({ soComEmail: true, emailDominio: ["grupo"] }) };
    const { salvarStatusCaptura, novoStatusCaptura } = await import("./status");
    const st = novoStatusCaptura({ lote, origem: "cnpj", estado: "parcial" });
    st.continuacao = { cursor: "p1", saltar: 0, lidasNaFonte: 10, filtros };
    await salvarStatusCaptura(TEAM, st);
    await basePrisma.prospectDraft.create({ data: { teamId: TEAM, origem: "cnpj", lote, nome: "x", ownerId: "ana", status: "pendente" } });
    adicionados.length = 0;
    await runWithTeam(TEAM, () => continuarBuscaPorFiltro(lote, 50), membro("ana"));
    expect(adicionados[0]!.data).toMatchObject({ completarContato: true, filtros: { opcoes: { soComEmail: true, emailDominio: ["grupo"] } } });
  });
});

function resultadoMinimo(cnpj: string) {
  return {
    cnpj,
    razaoSocial: "RAZAO",
    nomeFantasia: null,
    nome: "Sócio",
    nomeSocio: "Sócio",
    ie: null,
    situacao: "ATIVA",
    cnae: "0115600",
    cnaeDescricao: "Cultivo de soja",
    cnaesSecundarios: [],
    ies: [],
    cidade: "SORRISO",
    uf: "MT",
    endereco: null,
    telefone: null,
    email: "contato@exemplo.test",
    dataAbertura: null,
    fonte: "opencnpj" as const,
    parcial: true,
    socios: [],
    porte: null,
    capitalSocial: null,
  };
}
