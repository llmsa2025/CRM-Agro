import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { basePrisma } from "@crmagro/db";
import { CnpjInvalid, type PaginaDeBusca, type RegistroMinhaReceita } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";

const adicionados: { nome: string; data: Record<string, unknown>; opts: { jobId?: string } }[] = [];
vi.mock("bullmq", () => ({
  Queue: class {
    async add(nome: string, data: Record<string, unknown>, opts: { jobId?: string }) {
      adicionados.push({ nome, data, opts });
    }
  },
}));

// Nenhuma consulta de CNPJ vai à rede: o consultor é trocado por um falso.
const consultarFalso = vi.fn();
vi.mock("./cnpj", async (original) => ({ ...(await original<typeof import("./cnpj")>()), consultarCnpjDetalhado: (...a: unknown[]) => consultarFalso(...a) }));
vi.mock("./extras", async (original) => ({ ...(await original<typeof import("./extras")>()), marcarTemWhatsAppDoLote: vi.fn(async () => undefined) }));

import {
  BuscaSemContinuacao,
  FiltroInvalido,
  captureEmpresasDeSocio,
  coletarPorFiltro,
  continuarBuscaPorFiltro,
  executarCaptura,
  lerStatusCaptura,
  sociosDaEmpresa,
  type CaptureJob,
} from "./index";

/**
 * Aba "Por sócios": empresas de uma pessoa (por CPF ou por máscara) e sócios de uma empresa. Fonte
 * FALSA. CPFs de teste inventados e válidos: 529.982.247-25 (máscara ***982247**) e 111.444.777-35.
 */
const TEAM = "00000000-0000-0000-0000-0000000005c1";
const OUTRO = "00000000-0000-0000-0000-0000000005c2";
const CPF = "529.982.247-25";
const MASCARA = "***982247**";
const membro = (userId: string) => ({ userId, role: "member" });

type JobFiltro = Extract<CaptureJob, { origem: "cnpj"; modo: "filtro" }>;
let seq = 0;
const empresa = (qsa: RegistroMinhaReceita["qsa"], o: Partial<RegistroMinhaReceita> = {}): RegistroMinhaReceita => ({
  cnpj: `6${String(++seq).padStart(13, "0")}`,
  razao_social: `EMPRESA SOCIO ${seq}`,
  situacao_cadastral: 2,
  descricao_situacao_cadastral: "ATIVA",
  cnae_fiscal: 115600,
  municipio: "SORRISO",
  uf: "MT",
  ddd_telefone_1: "6635441234",
  codigo_natureza_juridica: 2062,
  qsa,
  ...o,
});
const maria = (nome = "MARIA APARECIDA SILVA") => ({ nome_socio: nome, qualificacao_socio: "Sócio-Administrador", cnpj_cpf_do_socio: MASCARA });
const outraPessoa = { nome_socio: "ANA PAULA SANTOS", qualificacao_socio: "Sócio", cnpj_cpf_do_socio: "***555666**" };

const fonteFalsa = (paginas: RegistroMinhaReceita[][]) =>
  vi.fn(async (_f: unknown, cursor: string | null): Promise<PaginaDeBusca> => {
    const i = cursor ? Number(cursor.slice(1)) : 0;
    return { registros: paginas[i] ?? [], cursor: i + 1 < paginas.length ? `p${i + 1}` : null };
  });

const sem = { pausaPaginaMs: 0, pausaConsultaMs: 0 };
const ultimoJob = () => adicionados[adicionados.length - 1]!.data as unknown as JobFiltro;

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Sócios A (test)"], [OUTRO, "Team Sócios B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
afterAll(() => undefined);
beforeEach(async () => {
  adicionados.length = 0;
  consultarFalso.mockReset();
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
});

describe("captureEmpresasDeSocio: o pedido", () => {
  it("CPF vira máscara no job; o CPF completo não vai para a fila, nem para o status, nem para o rascunho", async () => {
    const r = await runWithTeam(TEAM, () => captureEmpresasDeSocio({ cpf: CPF, nome: "Maria Aparecida Silva", uf: "MT", motivo: "cliente" }), membro("ana"));
    expect(adicionados).toHaveLength(1);
    const job = ultimoJob();
    expect(job).toMatchObject({
      origem: "cnpj",
      modo: "filtro",
      teamId: TEAM,
      lote: r.lote,
      ownerId: "ana",
      motivo: "cliente",
      checarWhatsApp: false,
      filtros: {
        fonte: { cnaes: [], ufs: ["MT"], municipios: [], cnpf: [MASCARA] },
        locais: { socio: { mascara: MASCARA, nome: "Maria Aparecida Silva" }, excluirPessoa: false, soAtivas: true },
      },
    });
    // O que a fila e o Redis guardam não tem os 11 dígitos do CPF.
    const tudo = JSON.stringify(adicionados) + JSON.stringify(await lerStatusCaptura(TEAM, r.lote));
    expect(tudo).not.toContain("52998224725");
    expect(tudo).not.toContain("529.982");
  });

  it("aceita a máscara de um sócio já listado (sem CPF)", async () => {
    await runWithTeam(TEAM, () => captureEmpresasDeSocio({ mascara: MASCARA, nome: "Maria Silva", motivo: "socio_de_empresa" }), membro("ana"));
    expect(ultimoJob().filtros.fonte.cnpf).toEqual([MASCARA]);
    expect(ultimoJob().filtros.locais.socio).toEqual({ mascara: MASCARA, nome: "Maria Silva" });
  });

  it("recusa CPF inválido, máscara inválida, nome de uma palavra só, cidade sem estado, sem motivo e sem documento", async () => {
    const pede = (e: Parameters<typeof captureEmpresasDeSocio>[0]) => runWithTeam(TEAM, () => captureEmpresasDeSocio(e), membro("ana"));
    await expect(pede({ cpf: "529.982.247-26", motivo: "cliente" })).rejects.toThrow(/CPF inválido/);
    await expect(pede({ cpf: "111.111.111-11", motivo: "cliente" })).rejects.toBeInstanceOf(FiltroInvalido);
    await expect(pede({ mascara: "***98**", motivo: "cliente" })).rejects.toThrow(/mascarado inválido/);
    await expect(pede({ cpf: CPF, nome: "Maria", motivo: "cliente" })).rejects.toThrow(/nome e sobrenome/);
    await expect(pede({ cpf: CPF, cidade: "Sorriso", motivo: "cliente" })).rejects.toThrow(/escolha o estado/);
    await expect(pede({ nome: "Maria Silva", motivo: "cliente" })).rejects.toThrow(/Informe o CPF/);
    // @ts-expect-error motivo é obrigatório
    await expect(pede({ cpf: CPF })).rejects.toBeInstanceOf(FiltroInvalido);
    await expect(pede({ cpf: CPF, motivo: "inventado" as never })).rejects.toBeInstanceOf(FiltroInvalido);
    expect(adicionados).toHaveLength(0);
  });

  it("só leitura (viewer) não busca", async () => {
    await expect(runWithTeam(TEAM, () => captureEmpresasDeSocio({ cpf: CPF, motivo: "cliente" }), { userId: "v", role: "viewer" })).rejects.toThrow();
    expect(adicionados).toHaveLength(0);
  });
});

describe("a busca por sócio no worker (fonte falsa)", () => {
  async function rodar(paginas: RegistroMinhaReceita[][], filtros: Partial<JobFiltro["filtros"]["locais"]> & { nome?: string | null }, extra: Partial<JobFiltro> = {}) {
    const { nome, ...resto } = filtros;
    const job: JobFiltro = {
      origem: "cnpj",
      modo: "filtro",
      teamId: TEAM,
      lote: crypto.randomUUID(),
      ownerId: "ana",
      limite: 100,
      motivo: "indicacao",
      filtros: {
        fonte: { cnaes: [], ufs: ["MT"], municipios: [], cnpf: [MASCARA] },
        locais: { soAtivas: true, excluirPessoa: false, portes: [], capitalMin: null, capitalMax: null, abertaDesde: null, abertaAte: null, soComTelefone: false, ...resto, socio: { mascara: MASCARA, nome: nome === undefined ? "Maria Silva" : nome } },
        cidades: [],
      },
      completarContato: false,
      checarWhatsApp: false,
      ...extra,
    };
    const st = await executarCaptura(job, coletarPorFiltro(job, { ...sem, buscarPagina: fonteFalsa(paginas) }));
    return { st, job, rs: await basePrisma.prospectDraft.findMany({ where: { teamId: TEAM, lote: job.lote } }) };
  }

  it("só entra empresa em que o sócio tem a máscara E o nome confere; o rascunho leva a pessoa, a confiança e o motivo", async () => {
    const certa = empresa([maria("MARIA APARECIDA SILVA"), outraPessoa]);
    const parcial = empresa([maria("MARIA SILVA")]);
    const homonimo = empresa([maria("MARIA APARECIDA SANTOS")]); // mesma máscara, outra pessoa
    const outra = empresa([outraPessoa]);
    const { st, rs } = await rodar([[certa, homonimo, outra, parcial]], {});
    expect(st).toMatchObject({ estado: "concluida", criados: 2 });
    const porCnpj = new Map(rs.map((r) => [r.cnpj, r]));
    expect(porCnpj.get(certa.cnpj!)).toMatchObject({ nome: "MARIA APARECIDA SILVA", origem: "cnpj", ownerId: "ana" });
    expect(porCnpj.get(certa.cnpj!)!.extra).toMatchObject({ busca: "socio", socioBuscado: { confianca: "media", qualificacao: "Sócio-Administrador" }, motivo: "indicacao", modo: "filtro" });
    expect(porCnpj.get(parcial.cnpj!)!.extra).toMatchObject({ socioBuscado: { confianca: "alta" } });
    expect(porCnpj.has(homonimo.cnpj!)).toBe(false);
    expect(porCnpj.has(outra.cnpj!)).toBe(false);
    // o rascunho não guarda a máscara nem CPF algum
    expect(JSON.stringify(rs)).not.toContain(MASCARA);
  });

  it("sem nome, a confiança é baixa (só a máscara bate)", async () => {
    const { rs } = await rodar([[empresa([maria()])]], { nome: null });
    expect(rs).toHaveLength(1);
    expect(rs[0]!.extra).toMatchObject({ socioBuscado: { confianca: "baixa" } });
  });

  it("empresário individual da própria pessoa entra (ela foi procurada de propósito); baixada só se pedir", async () => {
    const ei = empresa([maria("MARIA SILVA")], { codigo_natureza_juridica: 2135 });
    const baixada = empresa([maria("MARIA SILVA")], { situacao_cadastral: 8, descricao_situacao_cadastral: "BAIXADA" });
    expect((await rodar([[ei, baixada]], {})).rs.map((r) => r.cnpj)).toEqual([ei.cnpj]);
    expect((await rodar([[ei, baixada]], { soAtivas: false })).rs).toHaveLength(2);
  });

  it("completar contato: a pessoa procurada continua sendo o nome, mesmo quando a consulta traz outro 1º sócio", async () => {
    const e = empresa([maria("MARIA SILVA")]);
    consultarFalso.mockResolvedValue({
      origem: "opencnpj",
      resultado: { cnpj: e.cnpj, razaoSocial: "RAZAO", nomeFantasia: null, nome: "OUTRO SOCIO", nomeSocio: "OUTRO SOCIO", ie: null, situacao: "ATIVA", cnae: "0115600", cnaeDescricao: "Cultivo de soja", cnaesSecundarios: [], ies: [], cidade: "SORRISO", uf: "MT", endereco: null, telefone: null, email: "contato@exemplo.test", dataAbertura: null, fonte: "opencnpj", parcial: true, socios: [], porte: null, capitalSocial: null },
    });
    const { rs } = await rodar([[e]], {}, { completarContato: true });
    expect(rs[0]).toMatchObject({ nome: "MARIA SILVA", email: "contato@exemplo.test" });
  });

  it("Buscar mais continua a busca por sócio com a mesma máscara, só para quem fez a busca", async () => {
    const todas = Array.from({ length: 4 }, () => empresa([maria("MARIA SILVA")]));
    const { job } = await rodar([todas.slice(0, 2), todas.slice(2)], {}, { limite: 2 });
    const c = (await lerStatusCaptura(TEAM, job.lote))?.continuacao;
    expect(c?.filtros.locais.socio).toEqual({ mascara: MASCARA, nome: "Maria Silva" });
    await expect(runWithTeam(TEAM, () => continuarBuscaPorFiltro(job.lote, 10), membro("beto"))).rejects.toBeInstanceOf(BuscaSemContinuacao);
    await expect(runWithTeam(OUTRO, () => continuarBuscaPorFiltro(job.lote, 10), membro("ana"))).rejects.toBeInstanceOf(BuscaSemContinuacao);
    await runWithTeam(TEAM, () => continuarBuscaPorFiltro(job.lote, 10), membro("ana"));
    expect(ultimoJob().filtros.locais.socio).toEqual({ mascara: MASCARA, nome: "Maria Silva" });
    expect(ultimoJob().motivo).toBe("indicacao"); // o motivo da primeira rodada continua valendo
  });
});

describe("sociosDaEmpresa", () => {
  const resultado = {
    cnpj: "11222333000181",
    razaoSocial: "AGRO TESTE LTDA",
    situacao: "ATIVA",
    fonte: "cnpja",
    socios: [
      { nome: "MARIA APARECIDA SILVA", qualificacao: "Sócio-Administrador", cpfMascarado: MASCARA, faixaEtaria: "51-60" },
      { nome: "JOSE DE SOUZA", qualificacao: "Sócio" }, // fonte sem a máscara
    ],
  };

  it("lista nome, qualificação, faixa de idade, CPF para exibir e a máscara para buscar; sem a máscara, não dá para buscar", async () => {
    consultarFalso.mockResolvedValue({ resultado, origem: "cnpja" });
    const r = await runWithTeam(TEAM, () => sociosDaEmpresa("11.222.333/0001-81"), membro("ana"));
    expect(r).toMatchObject({ cnpj: "11222333000181", razaoSocial: "AGRO TESTE LTDA", fonte: "cnpja" });
    expect(r.socios).toEqual([
      { nome: "MARIA APARECIDA SILVA", qualificacao: "Sócio-Administrador", faixaEtaria: "51-60", cpfExibicao: "***.982.247-**", mascara: MASCARA },
      { nome: "JOSE DE SOUZA", qualificacao: "Sócio", faixaEtaria: null, cpfExibicao: null, mascara: null },
    ]);
  });

  it("CNPJ inválido volta o erro nomeado; viewer não consulta", async () => {
    consultarFalso.mockRejectedValue(new CnpjInvalid("123"));
    await expect(runWithTeam(TEAM, () => sociosDaEmpresa("123"), membro("ana"))).rejects.toBeInstanceOf(CnpjInvalid);
    consultarFalso.mockClear();
    await expect(runWithTeam(TEAM, () => sociosDaEmpresa("11222333000181"), { userId: "v", role: "viewer" })).rejects.toThrow();
    expect(consultarFalso).not.toHaveBeenCalled();
  });
});
