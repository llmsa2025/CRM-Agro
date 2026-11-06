import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { basePrisma, runWithTeam, runAsSystem } from "@crmagro/db";

/**
 * Responsável pelo contato (regra do dono, 28/09), "dois vendedores do mesmo
 * time": o João cadastrou o Marcos; o Pedro não cadastra o Marcos de novo (nem
 * pela tela, nem pela IA, nem pela importação, lista de campanha, ligação,
 * conversa ou captação) e não vê o contato. O gestor (master) vê o responsável,
 * escolhe o responsável no cadastro e recebe o id do existente.
 *
 * Nenhum envio: a fila e a checagem "tem WhatsApp?" da campanha são mockadas,
 * a conta de WhatsApp do teste não tem credencial e a conversa com o número
 * do colega é recusada antes de qualquer consulta externa.
 */
vi.mock("../campaigns/queue", () => ({ agendarMontagemDaLista: async () => {}, getCampaignQueue: () => ({}) }));
vi.mock("../campaigns/tem-whatsapp", () => ({
  temWhatsApp: async (numeros: string[]) => new Map(numeros.map((n) => [n, { existe: null, nome: null }])),
}));
// O gatilho do motor fica de fora (o teste é do cadastro, não do fluxo).
vi.mock("../flows/triggers", async (original) => ({
  ...(await original<typeof import("../flows/triggers")>()),
  safeEnrollByTrigger: async () => {},
  safeEnrollManyByTrigger: async () => {},
}));

const { createContactWithCompany } = await import("../companies/service");
const { create, list, findOrCreateContact } = await import("./service");
const { contactCreateSchema } = await import("./schema");
const { writeContact } = await import("./write");
const { ContatoJaCadastrado, ResponsavelInvalido } = await import("./errors");
const { opcoesDeResponsavel } = await import("./responsavel");
const { toolsForMode, ContatoJaCadastradoParaIa } = await import("../ai/tools");
const { createCampaign, prepararLista, montarLista } = await import("../campaigns/service");
const { createManualCall } = await import("../calls/service");
const { startConversationWithNumber } = await import("../conversations/service");
const { listDrafts, importDrafts } = await import("../captacao/service");

const TEAM = "00000000-0000-0000-0000-0000000e5b01";
const SEM_OWNER = "00000000-0000-0000-0000-0000000e5b02";
const TIMES = [TEAM, SEM_OWNER];
const sufixo = Math.random().toString(36).slice(2, 7);

type Pessoa = { id: string };
let master: Pessoa, joao: Pessoa, pedro: Pessoa, saiu: Pessoa;
let marcos = "";
let contaDoPedro = "";

/** Telefone do Marcos (cadastrado pelo João), em formatos diferentes. */
const TEL_MARCOS = "65 99999-0101";
const TEL_MARCOS_E164 = "+5565999990101";

const como = <T>(u: Pessoa, role: string, fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: u.id, role });
const doPedro = <T>(fn: () => Promise<T>) => como(pedro, "member", fn);
const doJoao = <T>(fn: () => Promise<T>) => como(joao, "member", fn);
const doMaster = <T>(fn: () => Promise<T>) => como(master, "owner", fn);
const contatosComNumero = (valor: string) => basePrisma.channelIdentifier.count({ where: { teamId: TEAM, canal: "whatsapp", valor } });
const donoDe = async (id: string) => (await basePrisma.contact.findUniqueOrThrow({ where: { id }, select: { ownerId: true } })).ownerId;

async function limpar() {
  for (const teamId of TIMES) {
    for (const m of [
      "campaignRecipient",
      "campaign",
      "call",
      "activity",
      "message",
      "conversation",
      "contactCompany",
      "company",
      "channelIdentifier",
      "prospectDraft",
      "channelAccount",
      "contact",
      "user",
    ] as const) {
      await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId } });
    }
  }
}

beforeAll(async () => {
  await limpar();
  for (const [id, name] of [[TEAM, "Responsável (test)"], [SEM_OWNER, "Responsável sem owner (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const mk = (name: string, role: string, extra: Record<string, unknown> = {}, teamId = TEAM) =>
    basePrisma.user.create({ data: { teamId, name, email: `${name.toLowerCase()}-${sufixo}@resp.dev`, role, ...extra } });
  master = await mk("Master", "owner");
  joao = await mk("João", "member");
  pedro = await mk("Pedro", "member");
  saiu = await mk("Saiu", "member", { desativadoEm: new Date() });
  // O João cadastra o Marcos (telefone + perfil do Instagram).
  marcos = (await doJoao(() => createContactWithCompany({ person: { nome: "Marcos", telefone: TEL_MARCOS, instagram: "@marcos.agro" } }))).contactId;
  contaDoPedro = (
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WhatsApp do Pedro", provider: "evolution", externalId: `resp-${sufixo}`, ownerId: pedro.id, status: "connected" },
    })
  ).id;
});

afterAll(limpar);

describe("cadastro manual", () => {
  it("quem cadastra vira o responsável", async () => {
    expect(await donoDe(marcos)).toBe(joao.id);
  });

  it("a mesma pessoa não entra duas vezes: o vendedor vê o nome do responsável e não abre o contato; o gestor recebe o id", async () => {
    const e = await doPedro(() => createContactWithCompany({ person: { nome: "Marcos Souza", telefone: "+55 (65) 99999-0101" } })).catch((x) => x);
    expect(e).toBeInstanceOf(ContatoJaCadastrado);
    expect(e).toMatchObject({ responsavelNome: "João", contactId: null });
    expect(e.message).toMatch(/responsável João.*gestor/);
    // O formulário simples (contacts.create) segue a mesma regra.
    await expect(doPedro(() => create(contactCreateSchema.parse({ nome: "Marcos", telefone: "65999990101" })))).rejects.toMatchObject({
      name: "ContatoJaCadastrado",
      responsavelNome: "João",
      contactId: null,
    });
    // Nada foi criado; o Pedro não vê o Marcos.
    expect(await contatosComNumero(TEL_MARCOS_E164)).toBe(1);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM, nome: { startsWith: "Marcos" } } })).toBe(1);
    expect((await doPedro(() => list())).items.map((c) => c.id)).not.toContain(marcos);

    // O próprio João e o gestor recebem o id para abrir o existente.
    await expect(doJoao(() => createContactWithCompany({ person: { nome: "Marcos", telefone: TEL_MARCOS } }))).rejects.toMatchObject({
      contactId: marcos,
    });
    await expect(doMaster(() => createContactWithCompany({ person: { nome: "Marcos", telefone: TEL_MARCOS } }))).rejects.toMatchObject({
      name: "ContatoJaCadastrado",
      responsavelNome: "João",
      contactId: marcos,
    });
    // Pelo perfil do Instagram também é a mesma pessoa.
    await expect(doPedro(() => createContactWithCompany({ person: { nome: "Outro Marcos", instagram: "marcos.agro" } }))).rejects.toMatchObject({
      name: "ContatoJaCadastrado",
    });
  });

  it("o gestor escolhe o responsável; o vendedor não escolhe outra pessoa", async () => {
    const r = await doMaster(() =>
      createContactWithCompany({ person: { nome: "Cliente para o Pedro", telefone: "65999990102" }, responsavelId: pedro.id }),
    );
    expect(await donoDe(r.contactId)).toBe(pedro.id);
    expect((await doPedro(() => list())).items.map((c) => c.id)).toContain(r.contactId);

    await expect(
      doPedro(() => createContactWithCompany({ person: { nome: "No nome do João", telefone: "65999990103" }, responsavelId: joao.id })),
    ).rejects.toMatchObject({ name: "ResponsavelInvalido", motivo: "so_gestor" });
    expect(await contatosComNumero("+5565999990103")).toBe(0);

    const meu = await doPedro(() => createContactWithCompany({ person: { nome: "Meu mesmo", telefone: "65999990103" }, responsavelId: pedro.id }));
    expect(await donoDe(meu.contactId)).toBe(pedro.id);

    // Pessoa desativada ou de fora do time não vira responsável.
    const invalido = await doMaster(() =>
      createContactWithCompany({ person: { nome: "Para quem saiu", telefone: "65999990108" }, responsavelId: saiu.id }),
    ).catch((x) => x);
    expect(invalido).toBeInstanceOf(ResponsavelInvalido);
    expect(invalido.motivo).toBe("pessoa_invalida");

    // Opções do campo: o gestor escolhe entre os ativos; o vendedor só vê a si.
    const doGestor = await doMaster(() => opcoesDeResponsavel());
    expect(doGestor.podeEscolher).toBe(true);
    expect(doGestor.pessoas.map((p) => p.nome).sort()).toEqual(["João", "Master", "Pedro"]);
    expect(await doPedro(() => opcoesDeResponsavel())).toEqual({ pessoas: [{ id: pedro.id, nome: "Pedro" }], eu: pedro.id, podeEscolher: false });
  });
});

describe("IA", () => {
  const ctx = { execId: "exec-resp", ultimaMensagemDoUsuario: "cadastra o Marcos" };
  const tool = (nome: string) => toolsForMode("read_write").find((t) => t.def.name === nome)!;

  it("contato de outro responsável: a IA recebe o motivo e NADA é gravado (nem nota, nem empresa)", async () => {
    const antes = {
      notas: await basePrisma.activity.count({ where: { contactId: marcos } }),
      empresas: await basePrisma.contactCompany.count({ where: { contactId: marcos } }),
    };
    const e = await doPedro(() =>
      tool("create_contact").run(
        { nome: "Marcos", telefone: TEL_MARCOS, empresa: "Fazenda Boa Vista", cnpj: "11222333000181", observacoes: "Planta 500 ha de soja" },
        ctx,
      ),
    ).catch((x: Error) => x);
    expect(e).toBeInstanceOf(ContatoJaCadastradoParaIa);
    expect((e as Error).message).toMatch(/NÃO cadastrado.*responsável João.*Nada foi gravado/s);
    expect(await basePrisma.activity.count({ where: { contactId: marcos } })).toBe(antes.notas);
    expect(await basePrisma.contactCompany.count({ where: { contactId: marcos } })).toBe(antes.empresas);
    expect(await basePrisma.company.count({ where: { teamId: TEAM } })).toBe(0);

    // Em lote: a linha do Marcos volta como erro; a outra entra com o Pedro.
    const lote = (await doPedro(() =>
      tool("create_contacts").run({ contatos: [{ nome: "Marcos", telefone: TEL_MARCOS }, { nome: "Novo pela IA", telefone: "65999990104" }] }, ctx),
    )) as { criados: number; jaExistiam: number; erros: string[] };
    expect(lote).toMatchObject({ criados: 1, jaExistiam: 0 });
    expect(lote.erros).toHaveLength(1);
    expect(lote.erros[0]).toMatch(/^Marcos: NÃO cadastrado.*João/);

    // O responsável reaproveita o próprio contato normalmente (nota gravada).
    const r = (await doJoao(() => tool("create_contact").run({ nome: "Marcos", telefone: TEL_MARCOS, observacoes: "Planta soja" }, ctx))) as {
      created: boolean;
      id: string;
    };
    expect(r).toMatchObject({ created: false, id: marcos });
    expect(await basePrisma.activity.count({ where: { contactId: marcos } })).toBe(antes.notas + 1);
  });
});

describe("sistema e fluxos que chegam pelo número", () => {
  it("lista de campanha: o contato do colega fica fora — nem como pulado com o nome dele", async () => {
    const c = await doPedro(() => createCampaign("Campanha do Pedro"));
    const { versao } = await doPedro(() => prepararLista(c.id, { tipo: "colados", texto: `Marcos; ${TEL_MARCOS}\nNovo da campanha; 65999990105` }));
    const resumo = await runAsSystem(TEAM, () => montarLista(c.id, versao, { historico: async () => false }));
    expect(resumo).toMatchObject({ contatosNovos: 1, fila: 1, pulados: 1, porMotivo: { "já cadastrado com outro responsável": 1 } });
    const dest = await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, select: { contactId: true } });
    expect(dest.map((d) => d.contactId)).not.toContain(marcos);
    expect(dest).toHaveLength(1);
    expect(await donoDe(dest[0]!.contactId)).toBe(pedro.id);
    expect(await contatosComNumero(TEL_MARCOS_E164)).toBe(1);
  });

  it("ligação pelo número do colega é recusada (não liga no nome dele nem duplica); o responsável liga", async () => {
    await expect(doPedro(() => createManualCall({ phoneNumber: "(65) 99999-0101" }))).rejects.toMatchObject({
      name: "ContatoJaCadastrado",
      responsavelNome: "João",
    });
    expect(await basePrisma.call.count({ where: { teamId: TEAM } })).toBe(0);
    expect(await contatosComNumero(TEL_MARCOS_E164)).toBe(1);
    const r = await doJoao(() => createManualCall({ phoneNumber: TEL_MARCOS }));
    expect(r.contactId).toBe(marcos);
  });

  it("conversa nova com o número do colega é recusada antes de abrir a conversa", async () => {
    await expect(doPedro(() => startConversationWithNumber(contaDoPedro, "Marcos", TEL_MARCOS))).rejects.toMatchObject({
      name: "ContatoJaCadastrado",
      responsavelNome: "João",
    });
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM, contactId: marcos } })).toBe(0);
  });

  it("webhook/motor (sistema puro) reaproveita o contato existente, de quem for", async () => {
    const r = await runAsSystem(TEAM, () => findOrCreateContact({ nome: "Marcos (webhook)", telefone: TEL_MARCOS }));
    expect(r).toEqual({ contactId: marcos, created: false });
  });
});

describe("captação", () => {
  it("listDrafts marca 'já cadastrado' pelo telefone e pelo perfil, com o responsável; importar pula a linha", async () => {
    const rasc = (dados: { nome: string; origem?: string; telefone?: string; extra?: object }) =>
      basePrisma.prospectDraft.create({
        data: { teamId: TEAM, origem: dados.origem ?? "maps", lote: `l-${sufixo}`, nome: dados.nome, telefone: dados.telefone ?? null, ownerId: pedro.id, ...(dados.extra ? { extra: dados.extra } : {}) },
      });
    const doMarcos = await rasc({ nome: "Marcos (Maps)", telefone: "(65) 99999-0101" });
    const nova = await rasc({ nome: "Fazenda Nova", telefone: "(65) 99999-0106" });
    const doMarcosIg = await rasc({ nome: "marcos.agro", origem: "instagram", extra: { username: "@Marcos.Agro" } });

    const fila = await doPedro(() => listDrafts({}));
    const de = (id: string) => fila.find((d) => d.id === id);
    expect(de(doMarcos.id)).toMatchObject({ jaExiste: true, jaExisteResponsavel: "João" });
    expect(de(doMarcosIg.id)).toMatchObject({ jaExiste: true, jaExisteResponsavel: "João" });
    expect(de(nova.id)).toMatchObject({ jaExiste: false, jaExisteResponsavel: null });

    // Chamada direta com as linhas já cadastradas: puladas, sem duplicar.
    expect(await doPedro(() => importDrafts([doMarcos.id, nova.id, doMarcosIg.id]))).toEqual({ importados: 1, pulados: 2 });
    expect(await contatosComNumero(TEL_MARCOS_E164)).toBe(1);
    const criado = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: "+5565999990106" } });
    expect(await donoDe(criado.contactId)).toBe(pedro.id);
  });
});

describe("responsável obrigatório", () => {
  it("o que entra pelo sistema sem pessoa fica com o master; job de quem saiu também", async () => {
    const r = await runAsSystem(TEAM, () => findOrCreateContact({ nome: "Lead do site", telefone: "65999990107" }));
    expect(r.created).toBe(true);
    expect(await donoDe(r.contactId)).toBe(master.id);
    const deQuemSaiu = await runAsSystem(TEAM, () =>
      writeContact({ nome: "Importado por quem saiu", identifiers: { whatsapp: "65999990109" }, provenance: { source: "teste", actor: "system" } }, { ownerId: saiu.id }),
    );
    expect(await donoDe(deQuemSaiu.contactId)).toBe(master.id);
  });

  it("time sem owner ativo: o admin mais antigo; sem admin, qualquer pessoa ativa", async () => {
    const mk = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      basePrisma.user.create({ data: { teamId: SEM_OWNER, name, email: `${name.toLowerCase()}-${sufixo}@resp2.dev`, role, ...extra } });
    await mk("DonoSaiu", "owner", { desativadoEm: new Date() });
    const admin = await mk("Admin", "admin");
    const membro = await mk("Membro", "member");
    const lead = (tel: string) => runAsSystem(SEM_OWNER, () => findOrCreateContact({ nome: "Lead", telefone: tel }));
    const a = await lead("65999990201");
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: a.contactId } })).ownerId).toBe(admin.id);
    await basePrisma.user.update({ where: { id: admin.id }, data: { desativadoEm: new Date() } });
    const b = await lead("65999990202");
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: b.contactId } })).ownerId).toBe(membro.id);
  });
});
