import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { SiteIndisponivel, type CnpjResult, type SiteLido } from "@crmagro/captation";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import {
  EmpresaSemFonte,
  PropostaExpirada,
  aplicarProposta,
  chaveDeComparacao,
  dadosPublicosDoCnpj,
  enriquecerEmpresasDoContatoAutomatico,
  montarItens,
  propostaDaEmpresa,
} from "./empresa";

/**
 * Enriquecer empresa: proposta com fonte e data de cada campo, nada gravado antes do OK, troca só se
 * marcada, o servidor é dono dos valores, escopo do contato e isolamento entre times. Fontes FALSAS:
 * nenhuma consulta de CNPJ nem de site vai à rede.
 */
const TEAM = "00000000-0000-0000-0000-0000000005e1";
const OUTRO = "00000000-0000-0000-0000-0000000005e2";
// Administrador vê e edita os contatos de todos (os testes de escopo usam membro com dono de verdade).
const adm = (userId: string) => ({ userId, role: "admin" });
const comoMembro = (userId: string) => ({ userId, role: "member" });
const AGORA = "2026-10-05T12:00:00.000Z";
const CNPJ = "11222333000181";

const resultado = (o: Partial<CnpjResult> = {}): CnpjResult => ({
  cnpj: CNPJ,
  razaoSocial: "AGRO TESTE LTDA",
  nomeFantasia: "Agro Teste",
  nome: "Sócio",
  nomeSocio: "Sócio",
  ie: "123456789",
  situacao: "ATIVA",
  cnae: "0115600",
  cnaeDescricao: "Cultivo de soja",
  cnaesSecundarios: [{ codigo: "0111302", descricao: "Cultivo de milho" }],
  ies: [{ numero: "123456789", tipo: "Produtor Rural", uf: "MT", habilitada: true }],
  cidade: "SORRISO",
  uf: "MT",
  endereco: "AVENIDA DOS COQUEIROS, 100, CENTRO",
  telefone: "(66) 3544-1234",
  telefones: ["(66) 3544-1234", "(66) 99987-6543"],
  email: "contato@agroteste.example",
  emails: [
    { valor: "contato@agroteste.example", tipo: "empresa" },
    { valor: "contabil@escritorio.com.br", tipo: "contador" },
  ],
  naturezaJuridica: "Sociedade Empresária Limitada",
  dataAbertura: "2015-03-10",
  fonte: "cnpja",
  parcial: false,
  socios: [{ nome: "MARIA APARECIDA SILVA", qualificacao: "Sócio-Administrador", cpfMascarado: "***982247**", faixaEtaria: "51-60" }],
  porte: "Pequeno",
  capitalSocial: 100000,
  consultadoEm: "2026-10-01T10:00:00.000Z",
  ...o,
});

const siteLido = (o: Partial<SiteLido["contatos"]> = {}): SiteLido => ({
  url: "https://agroteste.example/",
  paginas: ["https://agroteste.example/"],
  lidoEm: AGORA,
  contatos: { emails: [{ valor: "vendas@agroteste.example", doDominioDoSite: true, generico: false }], telefones: [{ valor: "5566999876543", whatsapp: true }], instagram: "https://www.instagram.com/agroteste", linkedin: null, facebook: null, ...o },
});

const consultarCom = (r: CnpjResult | Error) => vi.fn(async () => {
  if (r instanceof Error) throw r;
  return { resultado: r, origem: "cnpja" as const };
});

const criados: string[] = [];
/** Usuários de verdade no time (o dono do contato é FK). */
async function usuarios(n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await basePrisma.user.create({ data: { teamId: TEAM, name: `Pessoa ${i}`, email: `emp-${crypto.randomUUID()}@teste.invalid`, role: "member" } });
    criados.push(u.id);
    out.push(u.id);
  }
  return out;
}

let contatoId: string;
let empresaId: string;
async function montar(teamId = TEAM, dados: { empresa?: Record<string, unknown>; dono?: string } = {}) {
  const c = await basePrisma.contact.create({ data: { teamId, nome: "Fulano de Teste", ...(dados.dono ? { ownerId: null } : {}) } });
  const e = await basePrisma.company.create({ data: { teamId, nome: "Agro Teste", cnpj: CNPJ, ...(dados.empresa ?? {}) } });
  await basePrisma.contactCompany.create({ data: { teamId, contactId: c.id, companyId: e.id, papel: "dono" } });
  return { contatoId: c.id, empresaId: e.id };
}
const ler = () => basePrisma.company.findUniqueOrThrow({ where: { id: empresaId } });

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Empresa A (test)"], [OUTRO, "Team Empresa B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
beforeEach(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.enrichmentFact.deleteMany({ where: { teamId: t } });
    await basePrisma.contactCompany.deleteMany({ where: { teamId: t } });
    await basePrisma.company.deleteMany({ where: { teamId: t } });
    await basePrisma.contact.deleteMany({ where: { teamId: t } });
  }
  await basePrisma.user.deleteMany({ where: { id: { in: criados.splice(0) } } });
  ({ contatoId, empresaId } = await montar());
});

describe("montarItens (puro)", () => {
  it("cada item tem fonte, data e confiança; vazio = preencher, outro valor = trocar, mesmo valor = igual", () => {
    const itens = montarItens({ email: "meu@email.com", telefone: "(66) 3544-1234", ie: null, cidade: "Sorriso" }, resultado(), null, AGORA);
    const por = (campo: string) => itens.filter((i) => i.campo === campo);
    expect(por("email").map((i) => [i.valor, i.acao, i.confianca])).toEqual([
      ["contato@agroteste.example", "trocar", "alta"],
      ["contabil@escritorio.com.br", "trocar", "baixa"],
    ]);
    expect(por("email")[1]!.observacao).toMatch(/contabilidade/);
    // o contato já tem um telefone: o igual fica "igual" e o outro só entra se a pessoa marcar a troca
    expect(por("telefone").map((i) => [i.valor, i.acao])).toEqual([["(66) 3544-1234", "igual"], ["(66) 99987-6543", "trocar"]]);
    expect(por("cidade")[0]).toMatchObject({ acao: "igual" }); // "SORRISO" é a mesma cidade que "Sorriso"
    expect(por("ie")[0]).toMatchObject({ valor: "123456789", acao: "preencher", atual: null });
    expect(por("cnae")[0]).toMatchObject({ valor: "0115600", observacao: "Cultivo de soja" });
    for (const i of itens.filter((x) => x.fontes.includes("cnpja"))) expect(i).toMatchObject({ fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00.000Z" });
  });

  it("o site entra com a URL e confiança média/baixa; o mesmo e-mail em duas fontes sobe a confiança", () => {
    const itens = montarItens({}, resultado({ emails: [{ valor: "vendas@agroteste.example", tipo: "desconhecido" }], email: "vendas@agroteste.example" }), siteLido({ emails: [{ valor: "vendas@agroteste.example", doDominioDoSite: true, generico: false }, { valor: "fulano@gmail.com", doDominioDoSite: false, generico: true }] }), AGORA);
    const emails = itens.filter((i) => i.campo === "email");
    expect(emails.find((i) => i.valor === "vendas@agroteste.example")).toMatchObject({ fontes: ["cnpja", "site"], confianca: "alta", fonteRotulo: "CNPJá (Receita Federal) e Site da empresa" });
    expect(emails.find((i) => i.valor === "fulano@gmail.com")).toMatchObject({ fontes: ["site"], confianca: "baixa", fonteUrl: "https://agroteste.example/", consultadoEm: AGORA });
    expect(itens.find((i) => i.campo === "instagram")).toMatchObject({ valor: "https://www.instagram.com/agroteste", confianca: "media" });
    // o mesmo celular no CNPJ e no site vira um item só, com as duas fontes e a confiança alta
    expect(itens.find((i) => i.campo === "telefone" && i.valor === "(66) 99987-6543")).toMatchObject({ fontes: ["cnpja", "site"], confianca: "alta", observacao: "Tem link de WhatsApp no site" });
  });

  it("comparação: telefone sem 55 nem pontuação, e-mail em minúscula, IE só dígitos", () => {
    expect(chaveDeComparacao("telefone", "+55 (66) 99987-6543")).toBe(chaveDeComparacao("telefone", "66999876543"));
    expect(chaveDeComparacao("email", " A@B.com ")).toBe("a@b.com");
    expect(chaveDeComparacao("ie", "123.456.789-0")).toBe("1234567890");
  });

  it("dados públicos da Receita com fonte e data", () => {
    const d = dadosPublicosDoCnpj(resultado(), AGORA);
    expect(d.find((x) => x.rotulo === "Razão social")).toMatchObject({ valor: "AGRO TESTE LTDA", fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00.000Z" });
    expect(d.map((x) => x.rotulo)).toEqual(expect.arrayContaining(["Nome fantasia", "Situação cadastral", "Abertura", "Porte", "Capital social", "Atividade principal"]));
  });
});

describe("propostaDaEmpresa: só lê, nada é gravado", () => {
  it("monta a proposta, guarda no servidor e NÃO mexe na empresa", async () => {
    const antes = await ler();
    const p = await runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: consultarCom(resultado()), lerSite: vi.fn(), agora: () => new Date(AGORA) }), adm("ana"));
    expect(p.itens.length).toBeGreaterThan(5);
    expect(p).toMatchObject({ companyId: empresaId, companyNome: "Agro Teste", criadaEm: AGORA, avisos: [] });
    expect(p.socios).toEqual([{ nome: "MARIA APARECIDA SILVA", qualificacao: "Sócio-Administrador", cpfExibicao: "***.982.247-**", faixaEtaria: "51-60" }]);
    expect(JSON.stringify(p)).not.toContain("982247**"); // nem a máscara crua vai para a tela
    expect(await ler()).toEqual(antes);
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("sem CNPJ nem site: erro nomeado; CNPJ que falha vira aviso e o site continua", async () => {
    const { contatoId: c2, empresaId: e2 } = await montar(TEAM, { empresa: { cnpj: null } });
    await expect(runWithTeam(TEAM, () => propostaDaEmpresa(c2, e2), adm("ana"))).rejects.toBeInstanceOf(EmpresaSemFonte);
    await basePrisma.company.update({ where: { id: empresaId }, data: { site: "agroteste.example" } });
    const p = await runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: consultarCom(new Error("fora do ar")), lerSite: vi.fn(async () => siteLido()) }), adm("ana"));
    expect(p.avisos[0]).toMatch(/Não deu para consultar o CNPJ/);
    expect(p.itens.every((i) => i.fontes.includes("site"))).toBe(true);
  });

  it("site que não abre vira aviso com o motivo", async () => {
    await basePrisma.company.update({ where: { id: empresaId }, data: { site: "agroteste.example" } });
    const p = await runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: consultarCom(resultado()), lerSite: vi.fn(async () => { throw new SiteIndisponivel("robots"); }) }), adm("ana"));
    expect(p.avisos).toEqual(["O site pede que robôs não leiam esta página."]);
    expect(p.itens.length).toBeGreaterThan(0);
  });

  it("viewer não consulta; membro só enriquece contato dele (o de outro dono é recusado antes de qualquer consulta)", async () => {
    const f = consultarCom(resultado());
    await expect(runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: f }), { userId: "v", role: "viewer" })).rejects.toThrow();
    const [u1, u2] = await usuarios(2);
    await basePrisma.contact.update({ where: { id: contatoId }, data: { ownerId: u1! } });
    await expect(runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: f }), comoMembro(u2!))).rejects.toThrow(/contato não encontrado/);
    expect(f).not.toHaveBeenCalled();
    await expect(runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: f }), comoMembro(u1!))).resolves.toBeTruthy();
  });

  it("empresa que não é deste contato, ou de outro time, não é achada", async () => {
    const { empresaId: alheia } = await montar(OUTRO);
    await expect(runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, alheia, { consultarCnpj: consultarCom(resultado()) }), adm("ana"))).rejects.toThrow(/empresa não encontrada/);
  });
});

describe("aplicarProposta: só o que a pessoa marcou, com fonte e data", () => {
  const pedir = (user = "ana", extra = {}) => runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: consultarCom(resultado()), agora: () => new Date(AGORA), ...extra }), adm(user));
  const aplicar = (id: string, aceitos: string[], user = "ana", opts = {}) => runWithTeam(TEAM, () => aplicarProposta(id, aceitos, opts), adm(user));
  const idDe = (p: Awaited<ReturnType<typeof pedir>>, campo: string, valor?: string) => p.itens.find((i) => i.campo === campo && (valor === undefined || i.valor === valor))!.id;

  it("grava só os ids aceitos; o resto fica como estava", async () => {
    const p = await pedir();
    const r = await aplicar(p.id, [idDe(p, "ie"), idDe(p, "cidade")]);
    expect(r.aplicados.sort()).toEqual(["cidade", "ie"]);
    expect(await ler()).toMatchObject({ ie: "123456789", cidade: "SORRISO", email: null, telefone: null, endereco: null });
  });

  it("registra a fonte e a data de cada campo na ficha e no histórico (EnrichmentFact)", async () => {
    const p = await pedir();
    await aplicar(p.id, [idDe(p, "email", "contato@agroteste.example")]);
    const c = await ler();
    const campos = (c.enrichment as { campos: Record<string, Record<string, unknown>> }).campos;
    expect(campos.email).toMatchObject({ valor: "contato@agroteste.example", fonte: "cnpja", fonteRotulo: "CNPJá (Receita Federal)", consultadoEm: "2026-10-01T10:00:00.000Z", confianca: "alta", aplicadoPor: "ana" });
    const fatos = await basePrisma.enrichmentFact.findMany({ where: { teamId: TEAM, targetId: empresaId } });
    expect(fatos).toHaveLength(1);
    expect(fatos[0]).toMatchObject({ field: "email", source: "cnpja", enricherKey: "empresa", confidence: 0.9 });
    expect(fatos[0]!.producedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(fatos[0]!.appliedAt).not.toBeNull();
  });

  it("NÃO troca o que a pessoa digitou, a menos que ela marque a troca", async () => {
    await basePrisma.company.update({ where: { id: empresaId }, data: { email: "digitado@meu.com", telefone: "(66) 1111-1111" } });
    const p = await pedir();
    expect(p.itens.find((i) => i.campo === "email" && i.valor === "contato@agroteste.example")).toMatchObject({ acao: "trocar", atual: "digitado@meu.com" });
    // aceitando só a IE: e-mail e telefone digitados continuam
    await aplicar(p.id, [idDe(p, "ie")]);
    expect(await ler()).toMatchObject({ email: "digitado@meu.com", telefone: "(66) 1111-1111", ie: "123456789" });
    // marcando a troca do e-mail, só o e-mail muda
    const p2 = await pedir();
    await aplicar(p2.id, [idDe(p2, "email", "contato@agroteste.example")]);
    expect(await ler()).toMatchObject({ email: "contato@agroteste.example", telefone: "(66) 1111-1111" });
  });

  it("'preencher' cujo campo foi preenchido nesse meio tempo é ignorado (nunca pisa em dado novo)", async () => {
    const p = await pedir();
    await basePrisma.company.update({ where: { id: empresaId }, data: { ie: "999" } });
    const r = await aplicar(p.id, [idDe(p, "ie"), idDe(p, "cidade")]);
    expect(r).toMatchObject({ aplicados: ["cidade"], ignorados: ["ie"] });
    expect((await ler()).ie).toBe("999");
  });

  it("a tela só manda ids: id inventado e valor de fora não entram; dois itens do mesmo campo gravam um só", async () => {
    const p = await pedir();
    const r = await aplicar(p.id, ["email-9999", "'; DROP TABLE x;--", idDe(p, "email", "contato@agroteste.example"), idDe(p, "email", "contabil@escritorio.com.br")]);
    expect(r.aplicados).toEqual(["email"]);
    expect((await ler()).email).toBe("contato@agroteste.example"); // o de maior confiança (já vem primeiro)
  });

  it("dados públicos e campos de máquina: só com o OK; CNAEs secundários e tipos de IE só em empresa que não os tem", async () => {
    const p = await pedir();
    await aplicar(p.id, [idDe(p, "ie")]);
    let c = await ler();
    expect((c.enrichment as { publico?: unknown }).publico).toBeUndefined();
    expect(c.cnaesSecundarios).toEqual(["0111302"]); // insumo do classificador de produtor
    expect(c.iesTipos).toEqual([{ numero: "123456789", tipo: "Produtor Rural", uf: "MT", habilitada: true }]);
    const p2 = await pedir();
    await aplicar(p2.id, [], "ana", { incluirDadosPublicos: true });
    c = await ler();
    expect((c.enrichment as { publico: { rotulo: string }[] }).publico.map((d) => d.rotulo)).toContain("Razão social");
    expect((c.enrichment as { socios: unknown[] }).socios).toHaveLength(1);
  });

  it("a proposta é de quem a pediu e do time dele; usa-se uma vez só e expira", async () => {
    const p = await pedir("ana");
    await expect(aplicar(p.id, [idDe(p, "ie")], "beto")).rejects.toBeInstanceOf(PropostaExpirada);
    await expect(runWithTeam(OUTRO, () => aplicarProposta(p.id, [idDe(p, "ie")]), adm("ana"))).rejects.toBeInstanceOf(PropostaExpirada);
    await expect(aplicar(p.id, [idDe(p, "ie")], "ana")).resolves.toBeTruthy();
    await expect(aplicar(p.id, [idDe(p, "cidade")], "ana")).rejects.toBeInstanceOf(PropostaExpirada); // já usada
    await expect(aplicar("nao-e-uuid", [], "ana")).rejects.toBeInstanceOf(PropostaExpirada);
    await expect(runWithTeam(TEAM, () => aplicarProposta(p.id, []), { userId: "v", role: "viewer" })).rejects.toThrow();
  });

  it("depois de perder o acesso ao contato, aplicar é recusado (o escopo é conferido de novo)", async () => {
    const [u1, u2] = await usuarios(2);
    await basePrisma.contact.update({ where: { id: contatoId }, data: { ownerId: u1! } });
    const p = await runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: consultarCom(resultado()) }), comoMembro(u1!));
    await basePrisma.contact.update({ where: { id: contatoId }, data: { ownerId: u2! } }); // o contato passou para outra pessoa
    await expect(runWithTeam(TEAM, () => aplicarProposta(p.id, [idDe(p, "ie")]), comoMembro(u1!))).rejects.toThrow(/contato não encontrado/);
    expect((await ler()).ie).toBeNull();
  });
});

describe("modo automático (fluxos): só CNPJ, só campo vazio, nada de baixa confiança", () => {
  it("preenche o vazio, preserva o digitado, ignora o e-mail do contador e nunca lê o site", async () => {
    await basePrisma.company.update({ where: { id: empresaId }, data: { telefone: "(66) 1111-1111", site: "agroteste.example" } });
    const r = await runWithTeam(TEAM, () => enriquecerEmpresasDoContatoAutomatico(contatoId, { consultarCnpj: consultarCom(resultado()), agora: () => new Date(AGORA) }), { userId: "system", role: "system" });
    expect(r.empresas).toBe(1);
    const c = await ler();
    expect(c).toMatchObject({ ie: "123456789", email: "contato@agroteste.example", telefone: "(66) 1111-1111", cidade: "SORRISO", estado: "MT", cnae: "0115600", naturezaJuridica: "Sociedade Empresária Limitada" });
    expect(c.email).not.toBe("contabil@escritorio.com.br");
    const campos = (c.enrichment as { campos: Record<string, { aplicadoPor: string; fonte: string }> }).campos;
    expect(campos.ie).toMatchObject({ aplicadoPor: "automacao", fonte: "cnpja" });
    expect(campos.telefone).toBeUndefined(); // o digitado não ganhou proveniência de máquina
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, field: "telefone" } })).toBe(0);
  });

  it("não apaga os sócios que a pessoa já guardou pelo botão", async () => {
    const p = await runWithTeam(TEAM, () => propostaDaEmpresa(contatoId, empresaId, { consultarCnpj: consultarCom(resultado()), agora: () => new Date(AGORA) }), adm("ana"));
    await runWithTeam(TEAM, () => aplicarProposta(p.id, [], { incluirDadosPublicos: true }), adm("ana"));
    expect(((await ler()).enrichment as { socios: unknown[] }).socios).toHaveLength(1);
    await runWithTeam(TEAM, () => enriquecerEmpresasDoContatoAutomatico(contatoId, { consultarCnpj: consultarCom(resultado()) }), { userId: "system", role: "system" });
    const c = await ler();
    expect((c.enrichment as { socios: unknown[] }).socios).toHaveLength(1);
    expect(c.ie).toBe("123456789"); // e o automático preencheu o vazio
  });

  it("CNPJ que falha vira aviso e não derruba; rodar de novo não repete nada", async () => {
    const falha = await runWithTeam(TEAM, () => enriquecerEmpresasDoContatoAutomatico(contatoId, { consultarCnpj: consultarCom(new Error("fora")) }), { userId: "system", role: "system" });
    expect(falha).toMatchObject({ empresas: 0, campos: [] });
    expect(falha.avisos).toHaveLength(1);
    const f = consultarCom(resultado());
    await runWithTeam(TEAM, () => enriquecerEmpresasDoContatoAutomatico(contatoId, { consultarCnpj: f }), { userId: "system", role: "system" });
    const de_novo = await runWithTeam(TEAM, () => enriquecerEmpresasDoContatoAutomatico(contatoId, { consultarCnpj: f }), { userId: "system", role: "system" });
    expect(de_novo).toMatchObject({ empresas: 0, campos: [] });
  });
});
