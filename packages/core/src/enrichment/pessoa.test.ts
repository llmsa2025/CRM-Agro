import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import type { PaginaDeBusca, RegistroMinhaReceita } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import { cifrarCpf, lerCpf } from "../contacts/cpf";
import { salvarFontePaga, FonteDesligada, CustoNaoConfirmado, mesDeSaoPaulo } from "../captacao/fontes-pagas";

// A reclassificação de produtor não vai à rede nestes testes.
vi.mock("./registry", () => ({ runEnrichmentForContact: vi.fn(async () => ({ companiesEnriched: 0, produtorLabel: "produtor", applied: [] })) }));

import {
  CpfDaConsultaInvalido,
  PessoaSemDadoParaBuscar,
  PropostaDaPessoaExpirada,
  aplicarPropostaDaPessoa,
  consultarIeDaPessoa,
  enriquecerPessoaAutomatico,
  propostaDaPessoa,
} from "./pessoa";

/**
 * Enriquecer pessoa. Fontes FALSAS (busca na Minha Receita e API paga); CPFs inventados e válidos:
 * 529.982.247-25 (máscara ***982247**) e 111.444.777-35.
 */
const TEAM = "00000000-0000-0000-0000-0000000005f1";
const OUTRO = "00000000-0000-0000-0000-0000000005f2";
const CPF = "529.982.247-25";
const MASCARA = "***982247**";
const AGORA = "2026-10-05T12:00:00.000Z";
const adm = (userId: string) => ({ userId, role: "admin" });
const membro = (userId: string) => ({ userId, role: "member" });
const CHAVE = "chave-falsa-de-teste-123456";

let seq = 0;
const empresa = (nomeSocio: string, o: Partial<RegistroMinhaReceita> = {}, mascara = MASCARA): RegistroMinhaReceita => ({
  cnpj: `5${String(++seq).padStart(13, "0")}`,
  razao_social: `EMPRESA PESSOA ${seq}`,
  descricao_situacao_cadastral: "ATIVA",
  cnae_fiscal: 115600,
  cnae_fiscal_descricao: "Cultivo de soja",
  municipio: "SORRISO",
  uf: "MT",
  ddd_telefone_1: "6635441234",
  email: null,
  qsa: [{ nome_socio: nomeSocio, qualificacao_socio: "Sócio-Administrador", cnpj_cpf_do_socio: mascara }],
  ...o,
});

const fonte = (paginas: RegistroMinhaReceita[][]) =>
  vi.fn(async (_f: unknown, cursor: string | null): Promise<PaginaDeBusca> => {
    const i = cursor ? Number(cursor.slice(1)) : 0;
    return { registros: paginas[i] ?? [], cursor: i + 1 < paginas.length ? `p${i + 1}` : null };
  });

let contatoId: string;
async function novoContato(teamId = TEAM, dados: Record<string, unknown> = {}) {
  const c = await basePrisma.contact.create({ data: { teamId, nome: "Maria", sobrenome: "Aparecida Silva", ...dados } });
  return c.id;
}
/** Consulta de CNPJ falsa que não acha nada: nenhum teste vai à rede atrás do e-mail das empresas. */
const semConsulta = async (): Promise<never> => {
  throw new Error("sem rede nos testes");
};
const pedir = (entrada: Parameters<typeof propostaDaPessoa>[1], paginas: RegistroMinhaReceita[][], user = adm("ana"), id = contatoId, team = TEAM, consultarCnpj: unknown = semConsulta) =>
  runWithTeam(team, () => propostaDaPessoa(id, entrada, { buscarPagina: fonte(paginas), consultarCnpj: consultarCnpj as never, pausaMs: 0, agora: () => new Date(AGORA) }), user);

async function limpar() {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.enrichmentFact.deleteMany({ where: { teamId: t } });
    await basePrisma.contactCompany.deleteMany({ where: { teamId: t } });
    await basePrisma.company.deleteMany({ where: { teamId: t } });
    await basePrisma.contact.deleteMany({ where: { teamId: t } });
    await basePrisma.integration.deleteMany({ where: { teamId: t, tipo: "cnpja" } });
    await basePrisma.consultaDocumento.deleteMany({ where: { teamId: t } });
    await redisEstado().del(`fonte:uso:${t}:cnpja:${mesDeSaoPaulo()}`);
  }
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Pessoa A (test)"], [OUTRO, "Team Pessoa B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
beforeEach(async () => {
  await limpar();
  contatoId = await novoContato();
});
afterEach(() => vi.unstubAllGlobals());

describe("busca gratuita: empresas da pessoa", () => {
  it("só entra empresa com a máscara E o nome que confere; cada uma com confiança, fonte e data", async () => {
    const certa = empresa("MARIA SILVA");
    const parcial = empresa("MARIA APARECIDA SILVA"); // o nome buscado está contido: confiança média
    const homonimo = empresa("MARIA APARECIDA SANTOS"); // mesma máscara, outra pessoa
    const outra = empresa("ANA PAULA", {}, "***555666**");
    const p = await pedir({ cpf: CPF, nome: "Maria Silva", uf: "MT" }, [[homonimo, outra, parcial, certa]]);
    expect(p.empresas.map((e) => [e.cnpj, e.confianca])).toEqual([[certa.cnpj, "alta"], [parcial.cnpj, "media"]]);
    expect(p.empresas[0]).toMatchObject({ fonte: "minhareceita", fonteRotulo: "Minha Receita (Receita Federal)", consultadoEm: AGORA, qualificacao: "Sócio-Administrador", jaVinculada: false });
    expect(p.buscou).toEqual({ porCpf: true, cpfExibicao: "***.982.247-**", nome: "Maria Silva", uf: "MT", cidade: null, incluiuInativas: false });
  });

  it("usa o nome do contato quando não digitam; sem nome compatível a confiança é baixa e a tela avisa", async () => {
    const e = empresa("MARIA APARECIDA SILVA");
    expect((await pedir({ cpf: CPF }, [[e]])).empresas[0]!.confianca).toBe("alta"); // nome vem do cadastro do contato
    const solto = await novoContato(TEAM, { nome: "Maria", sobrenome: null });
    const p = await pedir({ cpf: CPF }, [[e]], adm("ana"), solto);
    expect(p.empresas[0]).toMatchObject({ confianca: "baixa", observacao: "Só o CPF bate: pode ser outra pessoa" });
    expect(p.avisos[0]).toMatch(/nome e sobrenome/);
  });

  it("e-mail e telefone iguais aos do contato sobem a confiança; a cidade filtra", async () => {
    const igual = empresa("MARIA APARECIDA SILVA", { email: "maria@fazenda.com.br" }); // nome contido: média, e alta pelo e-mail
    const outraCidade = empresa("MARIA APARECIDA SILVA", { municipio: "SINOP" });
    const p = await pedir({ cpf: CPF, nome: "Maria Silva", email: "MARIA@fazenda.com.br", cidade: "Sorriso" }, [[igual, outraCidade]]);
    expect(p.empresas).toHaveLength(1);
    expect(p.empresas[0]).toMatchObject({ cnpj: igual.cnpj, confianca: "alta", observacao: "e-mail igual ao do contato" });
    const porFone = await pedir({ cpf: CPF, nome: "Maria Silva", telefone: "(66) 3544-1234" }, [[empresa("MARIA APARECIDA SILVA")]]);
    expect(porFone.empresas[0]!.observacao).toMatch(/telefone igual/);
  });

  it("empresa já vinculada ao contato vem marcada (não vincula de novo)", async () => {
    const e = empresa("MARIA APARECIDA SILVA");
    const co = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Já minha", cnpj: e.cnpj! } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: contatoId, companyId: co.id } });
    expect((await pedir({ cpf: CPF }, [[e]])).empresas[0]!.jaVinculada).toBe(true);
  });

  it("o CPF digitado não é guardado: nem na proposta, nem no Redis, nem na resposta", async () => {
    const p = await pedir({ cpf: CPF }, [[empresa("MARIA APARECIDA SILVA")]]);
    const chaves = await redisEstado().keys(`enriq:pessoa:${TEAM}:*`);
    expect(chaves.length).toBeGreaterThan(0);
    const bruto = (await redisEstado().get(chaves[0]!)) ?? "";
    for (const t of [JSON.stringify(p), bruto]) {
      expect(t).not.toContain("52998224725");
      expect(t).not.toContain("529.982.247-25");
    }
  });

  it("usa o CPF cifrado do cadastro quando não digitam; sem CPF nenhum, não vai à rede e explica", async () => {
    const e = empresa("MARIA APARECIDA SILVA");
    await basePrisma.contact.update({ where: { id: contatoId }, data: { cpfCifrado: cifrarCpf(CPF) } });
    expect((await pedir({}, [[e]])).empresas).toHaveLength(1);
    const sem = await novoContato(TEAM);
    const f = fonte([[e]]);
    const p = await runWithTeam(TEAM, () => propostaDaPessoa(sem, {}, { buscarPagina: f, pausaMs: 0 }), adm("ana"));
    expect(f).not.toHaveBeenCalled();
    expect(p.empresas).toEqual([]);
    expect(p.avisos[0]).toMatch(/Sem o CPF/);
  });

  it("CPF inválido e UF inválida são recusados; quem não pode editar o contato não consulta", async () => {
    await expect(pedir({ cpf: "529.982.247-26" }, [[]])).rejects.toBeInstanceOf(PessoaSemDadoParaBuscar);
    await expect(pedir({ cpf: CPF, uf: "ZZ" }, [[]])).rejects.toBeInstanceOf(PessoaSemDadoParaBuscar);
    const u = await basePrisma.user.create({ data: { teamId: TEAM, name: "Dono", email: `p-${crypto.randomUUID()}@teste.invalid`, role: "member" } });
    await basePrisma.contact.update({ where: { id: contatoId }, data: { ownerId: u.id } });
    const f = fonte([[]]);
    await expect(runWithTeam(TEAM, () => propostaDaPessoa(contatoId, { cpf: CPF }, { buscarPagina: f }), membro("outro"))).rejects.toThrow(/contato não encontrado/);
    await expect(runWithTeam(TEAM, () => propostaDaPessoa(contatoId, { cpf: CPF }, { buscarPagina: f }), { userId: "v", role: "viewer" })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
    await basePrisma.contact.update({ where: { id: contatoId }, data: { ownerId: null } });
    await basePrisma.user.delete({ where: { id: u.id } });
  });

  it("erro da fonte no meio: devolve o que veio com aviso", async () => {
    let n = 0;
    const meio = vi.fn(async (): Promise<PaginaDeBusca> => {
      if (n++ === 0) return { registros: [empresa("MARIA APARECIDA SILVA")], cursor: "p1" };
      throw new Error("tempo esgotado (30s)");
    });
    const p = await runWithTeam(TEAM, () => propostaDaPessoa(contatoId, { cpf: CPF }, { buscarPagina: meio as never, consultarCnpj: semConsulta as never, pausaMs: 0 }), adm("ana"));
    expect(p.empresas).toHaveLength(1);
    expect(p.avisos[0]).toMatch(/parou/);
  });
});

describe("só empresas ativas", () => {
  const baixada = (o: Partial<RegistroMinhaReceita> = {}) => empresa("MARIA APARECIDA SILVA", { descricao_situacao_cadastral: "BAIXADA", situacao_cadastral: 8, ...o });

  it("empresa baixada, inapta ou suspensa fica de fora e a proposta diz quantas", async () => {
    const ativa = empresa("MARIA APARECIDA SILVA");
    const p = await pedir({ cpf: CPF }, [[baixada(), ativa, baixada({ descricao_situacao_cadastral: "INAPTA", situacao_cadastral: 4 })]]);
    expect(p.empresas.map((e) => [e.cnpj, e.ativa])).toEqual([[ativa.cnpj, true]]);
    expect(p.inativasOcultas).toBe(2);
    expect(p.buscou.incluiuInativas).toBe(false);
  });

  it("o código 2 da Receita vale como ativa mesmo sem o texto", async () => {
    const p = await pedir({ cpf: CPF }, [[empresa("MARIA APARECIDA SILVA", { descricao_situacao_cadastral: null, situacao_cadastral: 2 })]]);
    expect(p.empresas[0]).toMatchObject({ ativa: true });
  });

  it("com incluirInativas elas voltam marcadas como inativas e vão para o fim da lista", async () => {
    const velha = baixada();
    const ativa = empresa("MARIA APARECIDA SILVA");
    const p = await pedir({ cpf: CPF, incluirInativas: true }, [[velha, ativa]]);
    expect(p.empresas.map((e) => [e.cnpj, e.ativa])).toEqual([[ativa.cnpj, true], [velha.cnpj, false]]);
    expect(p.inativasOcultas).toBe(0);
    expect(p.buscou.incluiuInativas).toBe(true);
  });

  it("só inativas: o aviso explica e a lista fica vazia", async () => {
    const p = await pedir({ cpf: CPF }, [[baixada()]]);
    expect(p.empresas).toEqual([]);
    expect(p.avisos[0]).toBe("Nenhuma empresa ativa achada. 1 inativa ficou de fora.");
  });

  it("o passo de fluxo nunca vincula empresa inativa", async () => {
    await basePrisma.contact.update({ where: { id: contatoId }, data: { cpfCifrado: cifrarCpf(CPF) } });
    const ativa = empresa("MARIA APARECIDA SILVA");
    const velha = baixada();
    const detalhe = async () => ({ origem: "cnpja" as const, resultado: { cnpj: "x", razaoSocial: "R", nomeFantasia: null, nome: "x", nomeSocio: null, ie: null, situacao: "ATIVA", cnae: null, cnaeDescricao: null, cnaesSecundarios: [], ies: [], cidade: null, uf: null, endereco: null, telefone: null, email: null, dataAbertura: null, fonte: "cnpja" as const, parcial: false, socios: [], porte: null, capitalSocial: null } });
    const r = await runWithTeam(TEAM, () => enriquecerPessoaAutomatico(contatoId, {}, { buscarPagina: fonte([[velha, ativa]]), consultarCnpj: detalhe as never, pausaMs: 0 }), adm("ana"));
    expect(r.vinculadas).toBe(1);
    const cnpjs = (await basePrisma.contactCompany.findMany({ where: { contactId: contatoId }, include: { company: true } })).map((l) => l.company.cnpj);
    expect(cnpjs).toEqual([ativa.cnpj]);
  });
});

describe("telefone, e-mail e endereço das empresas", () => {
  const ei = (o: Partial<RegistroMinhaReceita> = {}) =>
    empresa("MARIA APARECIDA SILVA", { codigo_natureza_juridica: 2135, ddd_telefone_1: "66999881234", ddd_telefone_2: "6635441234", descricao_tipo_de_logradouro: "RUA", logradouro: "DAS FLORES", numero: "123", bairro: "CENTRO", ...o });
  const consulta = (emails: { valor: string; tipo: "empresa" | "contador" | "pessoal" | "desconhecido" }[]) => async () => ({ origem: "cache" as const, resultado: { emails } });

  it("sugere só celular (fixo fica de fora), e-mail que não é do contador e o endereço; empresário individual vem como provável dado da pessoa", async () => {
    const e = ei();
    const p = await pedir({ cpf: CPF }, [[e]], adm("ana"), contatoId, TEAM, consulta([{ valor: "Maria@Fazenda.com.br", tipo: "empresa" }, { valor: "contabil@escritorio.com.br", tipo: "contador" }]));
    expect(p.contatos.map((d) => [d.tipo, d.valor, d.provavelPessoal, d.jaNoCadastro])).toEqual([
      ["telefone", "66999881234", true, false],
      ["email", "maria@fazenda.com.br", true, false],
      ["endereco", "RUA DAS FLORES, 123, CENTRO", true, false],
    ]);
    expect(p.contatos[0]).toMatchObject({ exibicao: "(66) 99988-1234", empresa: e.razao_social, fonteRotulo: "Minha Receita (Receita Federal)", consultadoEm: AGORA });
    expect(p.contatos[2]).toMatchObject({ cidade: "SORRISO", uf: "MT" });
  });

  it("empresa de sociedade também é sugerida, mas sem a marca de dado da pessoa; confiança baixa e inativa não sugerem nada", async () => {
    const sociedade = empresa("MARIA APARECIDA SILVA", { ddd_telefone_1: "66999887766" });
    const soCpf = empresa("OUTRA PESSOA", { ddd_telefone_1: "66988776655" }); // nome diferente: não entra na lista
    const baixa = ei({ descricao_situacao_cadastral: "BAIXADA", situacao_cadastral: 8, ddd_telefone_1: "66977665544" });
    const p = await pedir({ cpf: CPF, incluirInativas: true }, [[sociedade, soCpf, baixa]]);
    expect(p.contatos.map((d) => [d.valor, d.provavelPessoal])).toEqual([["66999887766", false]]);
  });

  it("marca o que o contato já tem: telefone, e-mail e endereço", async () => {
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5566999881234", isPrimary: true } });
    await basePrisma.contact.update({ where: { id: contatoId }, data: { endereco: "Fazenda Boa Vista" } });
    const p = await pedir({ cpf: CPF, email: "maria@fazenda.com.br" }, [[ei()]], adm("ana"), contatoId, TEAM, consulta([{ valor: "maria@fazenda.com.br", tipo: "empresa" }]));
    expect(p.contatos.map((d) => [d.tipo, d.jaNoCadastro])).toEqual([["telefone", true], ["email", true], ["endereco", true]]);
  });

  it("aplicar acrescenta ao contato sem trocar o principal, completa o endereço vazio e registra a origem", async () => {
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5511988887777", isPrimary: true } });
    const p = await pedir({ cpf: CPF }, [[ei()]], adm("ana"), contatoId, TEAM, consulta([{ valor: "maria@fazenda.com.br", tipo: "empresa" }]));
    const r = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [], ies: [], contatos: p.contatos.map((d) => d.id) }), adm("ana"));
    expect(r.contatosAdicionados).toBe(3);
    const ids = await basePrisma.channelIdentifier.findMany({ where: { contactId: contatoId } });
    expect(ids.map((i) => `${i.canal} ${i.valor} ${i.isPrimary ? "principal" : "extra"}`).sort()).toEqual(["email maria@fazenda.com.br principal", "whatsapp +5511988887777 principal", "whatsapp +5566999881234 extra"]);
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoId } });
    expect(c).toMatchObject({ endereco: "RUA DAS FLORES, 123, CENTRO", cidade: "SORRISO", estado: "MT" });
    const fatos = await basePrisma.enrichmentFact.findMany({ where: { teamId: TEAM, targetId: contatoId }, orderBy: { field: "asc" } });
    expect(fatos.map((f) => f.field)).toEqual(["email_da_empresa", "endereco_da_empresa", "telefone_da_empresa"]);
    expect(fatos[0]).toMatchObject({ source: "minhareceita", confidence: 0.6, enricherKey: "pessoa" });
  });

  it("não acrescenta o que o contato já tem, nem o número que é de outro contato, nem troca o endereço que existe", async () => {
    const outro = await novoContato(TEAM, { nome: "Outro" });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: outro, canal: "whatsapp", valor: "+5566999881234", isPrimary: true } });
    await basePrisma.contact.update({ where: { id: contatoId }, data: { endereco: "Fazenda Boa Vista" } });
    const p = await pedir({ cpf: CPF }, [[ei()]]);
    const r = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [], ies: [], contatos: p.contatos.map((d) => d.id) }), adm("ana"));
    expect(r.contatosAdicionados).toBe(0);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoId } })).endereco).toBe("Fazenda Boa Vista");
    expect(await basePrisma.channelIdentifier.count({ where: { contactId: contatoId } })).toBe(0);
  });

  it("só entra o que foi marcado: id inventado não grava nada", async () => {
    const p = await pedir({ cpf: CPF }, [[ei()]]);
    const r = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [], ies: [], contatos: ["ct-99"] }), adm("ana"));
    expect(r.contatosAdicionados).toBe(0);
  });
});

describe("aplicar: só o que a pessoa marcou", () => {
  const detalhe = (cnpj: string) => async () => ({
    origem: "cnpja" as const,
    resultado: { cnpj, razaoSocial: "RAZAO COMPLETA LTDA", nomeFantasia: null, nome: "x", nomeSocio: null, ie: null, situacao: "ATIVA", cnae: "0115600", cnaeDescricao: null, cnaesSecundarios: [], ies: [], cidade: "SORRISO", uf: "MT", endereco: "RUA A, 1", telefone: "(66) 3544-1234", email: "c@x.com.br", dataAbertura: null, fonte: "cnpja" as const, parcial: false, socios: [], porte: null, capitalSocial: null, naturezaJuridica: "Sociedade Empresária Limitada" },
  });

  it("vincula só as empresas marcadas, com papel, dados da consulta e proveniência; as outras ficam de fora", async () => {
    const a = empresa("MARIA APARECIDA SILVA");
    const b = empresa("MARIA APARECIDA SILVA");
    const p = await pedir({ cpf: CPF }, [[a, b]]);
    const idA = p.empresas.find((e) => e.cnpj === a.cnpj)!.id;
    const r = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [idA], ies: [] }, { consultarCnpj: detalhe(a.cnpj!) as never }), adm("ana"));
    expect(r).toMatchObject({ empresasVinculadas: 1, iesGravadas: 0, cpfGuardado: false, produtorLabel: "produtor" });
    const links = await basePrisma.contactCompany.findMany({ where: { contactId: contatoId }, include: { company: true } });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ papel: "socio" });
    expect(links[0]!.company).toMatchObject({ cnpj: a.cnpj, nome: "RAZAO COMPLETA LTDA", telefone: "(66) 3544-1234", email: "c@x.com.br" });
    const fatos = await basePrisma.enrichmentFact.findMany({ where: { teamId: TEAM, targetId: contatoId } });
    expect(fatos).toHaveLength(1);
    expect(fatos[0]).toMatchObject({ field: "empresa_vinculada", source: "minhareceita", enricherKey: "pessoa", confidence: 0.9 });
    expect(fatos[0]!.producedAt.toISOString()).toBe(AGORA);
    // A situação cadastral fica na empresa, para o card mostrar "Ativa".
    expect((links[0]!.company.enrichment as { situacao: unknown }).situacao).toEqual({ ativa: true, descricao: "ATIVA", consultadoEm: AGORA, fonteRotulo: "Minha Receita (Receita Federal)" });
  });

  it("reusa a empresa do time que já tem o CNPJ (não duplica) e não vincula de novo a que já é do contato", async () => {
    const a = empresa("MARIA APARECIDA SILVA");
    const ja = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Existente", cnpj: a.cnpj! } });
    const p = await pedir({ cpf: CPF }, [[a]]);
    await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [p.empresas[0]!.id], ies: [] }, { consultarCnpj: detalhe(a.cnpj!) as never }), adm("ana"));
    expect(await basePrisma.company.count({ where: { teamId: TEAM, cnpj: a.cnpj! } })).toBe(1);
    expect((await basePrisma.contactCompany.findFirstOrThrow({ where: { contactId: contatoId } })).companyId).toBe(ja.id);
    const p2 = await pedir({ cpf: CPF }, [[a]]);
    expect(p2.empresas[0]!.jaVinculada).toBe(true);
    const r2 = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p2.id, { empresas: [p2.empresas[0]!.id], ies: [] }), adm("ana"));
    expect(r2.empresasVinculadas).toBe(0);
  });

  it("guardar o CPF: só se bater com a máscara buscada e só se o contato ainda não tem; vai cifrado", async () => {
    const p = await pedir({ cpf: CPF }, [[empresa("MARIA APARECIDA SILVA")]]);
    const errado = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [], ies: [], guardarCpf: "111.444.777-35" }), adm("ana"));
    expect(errado.cpfGuardado).toBe(false);
    const p2 = await pedir({ cpf: CPF }, [[empresa("MARIA APARECIDA SILVA")]]);
    const certo = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p2.id, { empresas: [], ies: [], guardarCpf: CPF }), adm("ana"));
    expect(certo.cpfGuardado).toBe(true);
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoId } });
    expect(c.cpfCifrado).not.toContain("52998224725");
    expect(lerCpf(c.cpfCifrado)).toBe(CPF);
  });

  it("a proposta é de quem pediu e do time dele; expira depois de usada; viewer não aplica", async () => {
    const p = await pedir({ cpf: CPF }, [[empresa("MARIA APARECIDA SILVA")]]);
    const ids = { empresas: [p.empresas[0]!.id], ies: [] };
    await expect(runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, ids), adm("beto"))).rejects.toBeInstanceOf(PropostaDaPessoaExpirada);
    await expect(runWithTeam(OUTRO, () => aplicarPropostaDaPessoa(p.id, ids), adm("ana"))).rejects.toBeInstanceOf(PropostaDaPessoaExpirada);
    await expect(runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, ids), { userId: "v", role: "viewer" })).rejects.toThrow();
    await expect(runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, ids, { consultarCnpj: detalhe("x") as never }), adm("ana"))).resolves.toBeTruthy();
    await expect(runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, ids), adm("ana"))).rejects.toBeInstanceOf(PropostaDaPessoaExpirada);
    await expect(runWithTeam(TEAM, () => aplicarPropostaDaPessoa("lixo", ids), adm("ana"))).rejects.toBeInstanceOf(PropostaDaPessoaExpirada);
  });

  it("id inventado na lista de aceitos não grava nada", async () => {
    const p = await pedir({ cpf: CPF }, [[empresa("MARIA APARECIDA SILVA")]]);
    const r = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: ["emp-999", "'; DROP TABLE x;--"], ies: ["ie-1"] }), adm("ana"));
    expect(r).toMatchObject({ empresasVinculadas: 0, iesGravadas: 0 });
    expect(await basePrisma.contactCompany.count({ where: { contactId: contatoId } })).toBe(0);
  });
});

describe("IE de produtor rural (fonte paga)", () => {
  const corpo = { name: "MARIA APARECIDA SILVA", originState: "MT", updated: "2026-10-01T10:00:00Z", registrations: [{ number: "13.456.789-0", state: "MT", enabled: true, statusDate: "2020-05-10", status: { text: "Habilitada" }, type: { text: "Produtor rural" } }] };
  const chamadas: string[] = [];
  let status = 200;
  const ligarFonte = (t = TEAM, extra = {}) => runWithTeam(t, () => salvarFontePaga("cnpja", { apiKey: CHAVE, precoCreditoCentavos: 75, ...extra }), adm("adm"));
  const consultar = (id: string, o: Partial<Parameters<typeof consultarIeDaPessoa>[1]> = {}, user = adm("ana"), team = TEAM) =>
    runWithTeam(team, () => consultarIeDaPessoa(id, { cpf: CPF, uf: "MT", motivo: "cliente", creditosConfirmados: 1, ...o }), user);

  beforeEach(() => {
    chamadas.length = 0;
    status = 200;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      chamadas.push(String(url));
      return new Response(status === 200 ? JSON.stringify(corpo) : "x", { status });
    }));
  });

  it("desligada por padrão: nada é consultado; membro não consulta mesmo ligada", async () => {
    const p = await pedir({ cpf: CPF }, [[]]);
    await expect(consultar(p.id)).rejects.toBeInstanceOf(FonteDesligada);
    await ligarFonte();
    await expect(consultar(p.id, {}, membro("ana"))).rejects.toThrow();
    expect(chamadas).toHaveLength(0);
  });

  it("exige confirmar o custo; com a fonte ligada traz as IEs com fonte, data e confiança, e registra sem o CPF", async () => {
    await ligarFonte();
    const p = await pedir({ cpf: CPF }, [[]]);
    await expect(consultar(p.id, { creditosConfirmados: 0 })).rejects.toBeInstanceOf(CustoNaoConfirmado);
    expect(chamadas).toHaveLength(0);
    const r = await consultar(p.id);
    expect(r.ies).toEqual([{ id: "ie-1", numero: "13.456.789-0", uf: "MT", habilitada: true, situacao: "Habilitada", tipo: "Produtor rural", fonte: "cnpja", fonteRotulo: "CNPJá (Cadastro de Contribuintes)", consultadoEm: expect.any(String), confianca: "alta" }]);
    expect(chamadas).toHaveLength(1);
    expect(new URL(chamadas[0]!).searchParams.get("states")).toBe("MT");
    const linhas = await basePrisma.consultaDocumento.findMany({ where: { teamId: TEAM } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ userId: "ana", tipo: "cpf", uf: "MT", motivo: "cliente", fonte: "cnpja", creditos: 1, custoCentavos: 75, documentoMascarado: "***.982.247-**", contactId: contatoId });
    const texto = JSON.stringify(linhas);
    expect(texto).not.toContain("52998224725");
    expect(texto).not.toContain("529.982");
    // A proposta guardada também não tem o CPF.
    const bruto = (await redisEstado().get((await redisEstado().keys(`enriq:pessoa:${TEAM}:*`))[0]!)) ?? "";
    expect(bruto).not.toContain("52998224725");
  });

  it("não usa a proposta de uma pessoa para consultar o CPF de outra", async () => {
    await ligarFonte();
    const p = await pedir({ cpf: CPF }, [[]]);
    await expect(consultar(p.id, { cpf: "111.444.777-35" })).rejects.toBeInstanceOf(CpfDaConsultaInvalido);
    await expect(consultar(p.id, { cpf: "123" })).rejects.toBeInstanceOf(CpfDaConsultaInvalido);
    expect(chamadas).toHaveLength(0);
  });

  it("sem inscrição na UF (404): a proposta diz isso, não é erro, e a cota fica gasta; mesma IE duas vezes não duplica", async () => {
    await ligarFonte();
    const p = await pedir({ cpf: CPF }, [[]]);
    status = 404;
    const r = await consultar(p.id, { uf: "GO" });
    expect(r.ies).toEqual([]);
    expect(r.avisos.join(" ")).toMatch(/Nenhuma inscrição de produtor rural em GO/);
    status = 200;
    await consultar(p.id);
    const r3 = await consultar(p.id);
    expect(r3.ies).toHaveLength(1);
  });

  it("outro time não usa nem vê: a proposta e a fonte são do time", async () => {
    await ligarFonte(TEAM);
    const p = await pedir({ cpf: CPF }, [[]]);
    await ligarFonte(OUTRO);
    await expect(consultar(p.id, {}, adm("ana"), OUTRO)).rejects.toBeInstanceOf(PropostaDaPessoaExpirada);
    expect(chamadas).toHaveLength(0);
  });

  it("aplicar a IE cria a empresa de produtor rural (sem CNPJ) com a IE e os tipos, papel dono, com proveniência", async () => {
    await ligarFonte();
    const p = await pedir({ cpf: CPF }, [[]]);
    const comIe = await consultar(p.id);
    const r = await runWithTeam(TEAM, () => aplicarPropostaDaPessoa(p.id, { empresas: [], ies: [comIe.ies[0]!.id] }), adm("ana"));
    expect(r).toMatchObject({ iesGravadas: 1, produtorLabel: "produtor" });
    const link = await basePrisma.contactCompany.findFirstOrThrow({ where: { contactId: contatoId }, include: { company: true } });
    expect(link.papel).toBe("dono");
    expect(link.company).toMatchObject({ cnpj: null, ie: "13.456.789-0", estado: "MT", naturezaJuridica: "Produtor rural (pessoa física)", nome: "Produtor rural Maria Aparecida Silva" });
    expect(link.company.iesTipos).toEqual([{ numero: "13.456.789-0", tipo: "Produtor rural", uf: "MT", habilitada: true }]);
    const fato = await basePrisma.enrichmentFact.findFirstOrThrow({ where: { teamId: TEAM, field: "ie_produtor" } });
    expect(fato).toMatchObject({ source: "cnpja", confidence: 0.9, enricherKey: "pessoa" });
  });
});
