import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import type { PaginaDeBusca } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { cifrarCpf } from "../contacts/cpf";

/**
 * Os passos "Enriquecer empresa" e "Enriquecer pessoa" dos fluxos (substituem o "Enriquecer dados", que segue
 * funcionando). Fila, consulta de CNPJ e busca na Receita MOCKADAS; CPF inventado e válido (529.982.247-25).
 */
vi.mock("./queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));
const cnpjMock = vi.hoisted(() => ({ falha: false, chamadas: [] as string[] }));
vi.mock("../captacao/cnpj", async (importOriginal) => {
  const real = await importOriginal<typeof import("../captacao/cnpj")>();
  const resultado = (cnpj: string) => ({
    cnpj, razaoSocial: "AGRO LTDA", nomeFantasia: null, nome: "x", nomeSocio: null, ie: "123456789", situacao: "ATIVA",
    cnae: "0115600", cnaeDescricao: "Cultivo de soja", cnaesSecundarios: [], ies: [], cidade: "SORRISO", uf: "MT",
    endereco: "RUA A, 10", telefone: "(66) 3333-7703", telefones: ["(66) 3333-7703"], email: "contato@agro.com", emails: [{ valor: "contato@agro.com", tipo: "empresa" }, { valor: "contador@escritorio.com", tipo: "contador" }],
    dataAbertura: null, fonte: "cnpja", parcial: false, socios: [], porte: null, capitalSocial: null, naturezaJuridica: "Sociedade Empresária Limitada", consultadoEm: "2026-10-01T10:00:00.000Z",
  });
  const detalhado = async (cnpj: string) => {
    cnpjMock.chamadas.push(cnpj);
    if (cnpjMock.falha) throw new Error("fora do ar");
    return { resultado: resultado(cnpj), origem: "cnpja" };
  };
  return { ...real, consultarCnpjDetalhado: detalhado, consultarCnpj: async (c: string) => (await detalhado(c)).resultado };
});
const busca = vi.hoisted(() => ({ paginas: [] as unknown[][], chamadas: 0, falha: false }));
vi.mock("@crmagro/captation", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/captation")>();
  return {
    ...real,
    buscarPaginaMinhaReceita: async (): Promise<PaginaDeBusca> => {
      busca.chamadas++;
      if (busca.falha) throw new Error("tempo esgotado (30s)");
      return { registros: (busca.paginas[0] ?? []) as never, cursor: null };
    },
  };
});
vi.mock("../enrichment/registry", () => ({ runEnrichmentForContact: vi.fn(async () => ({ companiesEnriched: 0, produtorLabel: null, applied: [] })) }));

const { executeNode } = await import("./executor");
const { enriquecerPessoaDoFluxo } = await import("./enriquecer-dados");
const { snapshotNodeSchema } = await import("./schema");
const { noServeAoTipo } = await import("./tipos");
const { custoDoPasso } = await import("./justica");

const TEAM = "00000000-0000-0000-0000-0000000000e7";
const CPF = "529.982.247-25";
const MASCARA = "***982247**";
let contatoId = "";

const limpar = async () => {
  const w = { teamId: TEAM };
  await basePrisma.enrichmentFact.deleteMany({ where: w });
  await basePrisma.contactCompany.deleteMany({ where: w });
  await basePrisma.company.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
};
beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team enriquecer empresa e pessoa nos fluxos" } });
});
beforeEach(async () => {
  cnpjMock.falha = false;
  cnpjMock.chamadas.length = 0;
  busca.paginas = [];
  busca.chamadas = 0;
  busca.falha = false;
  await limpar();
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria", sobrenome: "Aparecida Silva" } })).id;
});
afterAll(limpar);

const enr = () => ({ id: "enr-x", teamId: TEAM, contactId: contatoId, lastOutboundAt: null, round: 1, contact: { id: contatoId, nome: "Maria", tags: [], ownerId: null, relacionamentoStatus: "novo" } }) as never;
const rodar = (node: object) => runWithTeam(TEAM, () => executeNode(enr(), node as never), { userId: "system", role: "system" });
const empresa = async (cnpj: string | null, extra: Record<string, unknown> = {}) => {
  const c = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Agro Lima", cnpj, ...extra } });
  await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: contatoId, companyId: c.id, papel: "dono" } });
  return c.id;
};
const sociedade = (nome: string, mascara = MASCARA, o: Record<string, unknown> = {}) => ({
  cnpj: "55666777000188", razao_social: "EMPRESA DA MARIA LTDA", descricao_situacao_cadastral: "ATIVA", municipio: "SORRISO", uf: "MT",
  qsa: [{ nome_socio: nome, qualificacao_socio: "Sócio-Administrador", cnpj_cpf_do_socio: mascara }], ...o,
});

describe("os dois passos existem, valem em fluxo de prospecção e enriquecimento e custam como consulta externa", () => {
  it("o snapshot aceita os dois tipos novos e continua aceitando o antigo", () => {
    for (const tipo of ["enrich_data", "enrich_company", "enrich_person"]) {
      expect(snapshotNodeSchema.safeParse({ id: "n", tipo, config: {}, nextNodeId: null }).success, tipo).toBe(true);
    }
    expect(snapshotNodeSchema.safeParse({ id: "n", tipo: "enrich_person", config: { incluirConfiancaMedia: true }, nextNodeId: null }).success).toBe(true);
    expect(snapshotNodeSchema.safeParse({ id: "n", tipo: "enrich_person", config: { incluirConfiancaMedia: "sim" }, nextNodeId: null }).success).toBe(false);
    expect(snapshotNodeSchema.safeParse({ id: "n", tipo: "enrich_inventado", config: {}, nextNodeId: null }).success).toBe(false);
  });
  it("tipos de fluxo e custo", () => {
    for (const t of ["enrich_data", "enrich_company", "enrich_person"]) {
      expect(noServeAoTipo("prospeccao", t), t).toBe(true);
      expect(noServeAoTipo("enriquecimento", t), t).toBe(true);
      expect(noServeAoTipo("marketing", t), t).toBe(false);
      expect(custoDoPasso({ tipo: t }), t).toBe(1);
    }
  });
});

describe("passo Enriquecer empresa", () => {
  it("preenche só o vazio, com fonte e data, e segue; o digitado e o e-mail do contador ficam de fora", async () => {
    const id = await empresa("01234567000195", { email: "meu@email.com" });
    const r = await rodar({ id: "n1", tipo: "enrich_company", config: {}, nextNodeId: "prox" });
    expect(r).toMatchObject({ nextNodeId: "prox", motivo: expect.stringMatching(/^Preencheu \d+ campo\(s\)/) });
    expect(r).not.toHaveProperty("skipped");
    const c = await basePrisma.company.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ ie: "123456789", email: "meu@email.com", telefone: "(66) 3333-7703", cidade: "SORRISO", estado: "MT", cnae: "0115600" });
    expect((c.enrichment as { campos: Record<string, { fonteRotulo: string; consultadoEm: string }> }).campos.ie).toMatchObject({ fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00.000Z" });
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: id, field: "email" } })).toBe(0); // o digitado não virou fato de máquina
    // rodar de novo não repete nada
    expect(await rodar({ id: "n1", tipo: "enrich_company", config: {}, nextNodeId: "prox" })).toMatchObject({ nextNodeId: "prox", motivo: "1 CNPJ consultado(s), nada novo para preencher" });
  });

  it("sem empresa, sem CNPJ ou com a consulta fora do ar: pula e diz o motivo", async () => {
    expect(await rodar({ id: "n1", tipo: "enrich_company", config: {}, nextNodeId: "p" })).toMatchObject({ skipped: true, motivo: "Sem empresa cadastrada para consultar" });
    await empresa(null);
    expect(await rodar({ id: "n1", tipo: "enrich_company", config: {}, nextNodeId: "p" })).toMatchObject({ skipped: true, motivo: "Nenhuma empresa com CNPJ para consultar" });
    await empresa("01234567000195");
    cnpjMock.falha = true;
    expect(await rodar({ id: "n1", tipo: "enrich_company", config: {}, nextNodeId: "p" })).toMatchObject({ skipped: true, motivo: "A consulta de CNPJ não respondeu agora" });
  });

  it("o passo antigo (Enriquecer dados) continua funcionando como antes", async () => {
    const id = await empresa("01234567000195");
    const r = await rodar({ id: "n1", tipo: "enrich_data", config: {}, nextNodeId: "prox" });
    expect(r).toMatchObject({ nextNodeId: "prox", motivo: expect.stringMatching(/^Preencheu \d+ campo\(s\)/) });
    expect((await basePrisma.company.findUniqueOrThrow({ where: { id } })).ie).toBe("123456789");
  });
});

describe("passo Enriquecer pessoa", () => {
  const comCpf = () => basePrisma.contact.update({ where: { id: contatoId }, data: { cpfCifrado: cifrarCpf(CPF) } });
  const passo = (config: object = {}) => rodar({ id: "n2", tipo: "enrich_person", config, nextNodeId: "prox" });

  it("sem CPF no cadastro pula, sem ir à rede, e diz por quê", async () => {
    busca.paginas = [[sociedade("MARIA APARECIDA SILVA")]];
    expect(await passo()).toMatchObject({ skipped: true, motivo: expect.stringMatching(/Sem CPF no cadastro/) });
    expect(busca.chamadas).toBe(0);
  });

  it("com o CPF guardado vincula as empresas de nome igual (confiança alta) e guarda fonte e data; nunca olha fonte paga", async () => {
    await comCpf();
    busca.paginas = [[sociedade("MARIA APARECIDA SILVA")]];
    const r = await passo();
    expect(r).toMatchObject({ nextNodeId: "prox", motivo: expect.stringMatching(/^Vinculou 1 empresa \(confiança alta\)/) });
    const link = await basePrisma.contactCompany.findFirstOrThrow({ where: { contactId: contatoId }, include: { company: true } });
    expect(link.company.cnpj).toBe("55666777000188");
    const fato = await basePrisma.enrichmentFact.findFirstOrThrow({ where: { teamId: TEAM, targetId: contatoId, field: "empresa_vinculada" } });
    expect(fato).toMatchObject({ source: "minhareceita", enricherKey: "pessoa" });
    expect(await basePrisma.consultaDocumento.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("nome parecido só entra se o passo permitir; homônimo (outro nome com a mesma máscara) nunca", async () => {
    await comCpf();
    busca.paginas = [[sociedade("MARIA APARECIDA DE FATIMA SILVA")]]; // o nome do cadastro está contido: confiança média
    expect(await passo()).toMatchObject({ motivo: expect.stringMatching(/nenhuma com confiança suficiente/) });
    expect(await basePrisma.contactCompany.count({ where: { contactId: contatoId } })).toBe(0);
    expect(await passo({ incluirConfiancaMedia: true })).toMatchObject({ motivo: expect.stringMatching(/^Vinculou 1 empresa \(confiança alta ou média\)/) });
    await basePrisma.contactCompany.deleteMany({ where: { contactId: contatoId } });
    busca.paginas = [[sociedade("MARIA APARECIDA SANTOS")]];
    expect(await passo({ incluirConfiancaMedia: true })).toMatchObject({ motivo: "Nenhuma empresa achada com esse CPF e esse nome" });
    expect(await basePrisma.contactCompany.count({ where: { contactId: contatoId } })).toBe(0);
  });

  it("contato com nome de uma palavra só pula; Receita fora do ar pula; rodar de novo não duplica", async () => {
    await comCpf();
    await basePrisma.contact.update({ where: { id: contatoId }, data: { sobrenome: null } });
    expect(await passo()).toMatchObject({ skipped: true, motivo: expect.stringMatching(/nome e sobrenome/) });
    await basePrisma.contact.update({ where: { id: contatoId }, data: { sobrenome: "Aparecida Silva" } });
    busca.falha = true;
    expect(await passo()).toMatchObject({ skipped: true, motivo: "A consulta na Receita não respondeu agora" });
    busca.falha = false;
    busca.paginas = [[sociedade("MARIA APARECIDA SILVA")]];
    await passo();
    expect(await passo()).toMatchObject({ motivo: expect.stringMatching(/nenhuma com confiança suficiente|Nenhuma/) });
    expect(await basePrisma.company.count({ where: { teamId: TEAM, cnpj: "55666777000188" } })).toBe(1);
  });

  it("outro time não é tocado (o passo roda no time do contato)", async () => {
    const OUTRO = "00000000-0000-0000-0000-0000000000e8";
    await basePrisma.team.upsert({ where: { id: OUTRO }, update: {}, create: { id: OUTRO, name: "Team outro enriquecer fluxo" } });
    await comCpf();
    busca.paginas = [[sociedade("MARIA APARECIDA SILVA")]];
    const r = await runWithTeam(OUTRO, () => enriquecerPessoaDoFluxo(contatoId), { userId: "system", role: "system" }).catch((e) => e);
    // o contato é do outro time: não existe lá (erro ou pulo), e nada foi vinculado
    expect(r instanceof Error || (r as { skipped?: boolean }).skipped).toBeTruthy();
    expect(await basePrisma.contactCompany.count({ where: { contactId: contatoId } })).toBe(0);
    expect(await basePrisma.company.count({ where: { teamId: OUTRO } })).toBe(0);
    await basePrisma.team.delete({ where: { id: OUTRO } });
  });
});
