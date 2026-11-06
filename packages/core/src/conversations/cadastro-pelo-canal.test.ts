import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import { nomeCompleto } from "./nome";

/**
 * Cadastro COMPLETO do contato pelo canal (pessoa + empresa, os campos da tela "Novo contato") e o nome completo
 * (nome + sobrenome) na lista de conversas e na busca. Banco de TESTE; nada vai a canal nenhum.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: vi.fn(),
  getFlowQueue: () => ({}),
}));

const { cadastrarContatoDaConversa, listConversations } = await import("./service");
const { setRelacionamentoStatus, setRelacionamentoStatusBulk } = await import("../contacts/service");

const TEAM = "00000000-0000-0000-0000-0000000c0de1";
const OUTRO = "00000000-0000-0000-0000-0000000c0de2";
const sufixo = Math.random().toString(36).slice(2, 8);
const NUMERO = "+5566988887777"; // E.164, como o webhook grava

let contaId = "";
let dono: { id: string };
let n = 0;

const como = <T>(fn: () => Promise<T>, role = "owner", time = TEAM) => runWithTeam(time, fn, { userId: role === "owner" ? dono.id : `u-${role}`, role });

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.contactCompany.deleteMany({ where: w });
  await basePrisma.company.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await basePrisma.user.deleteMany({ where: w });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team cadastro pelo canal"], [OUTRO, "Team cadastro pelo canal B"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
  dono = await basePrisma.user.create({ data: { teamId: TEAM, name: "Dono", email: `dono-${sufixo}-${++n}@canal.dev`, role: "owner" } });
  contaId = (
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `canal-${sufixo}-${n}`, status: "connected", ownerId: dono.id },
    })
  ).id;
});

afterAll(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.team.deleteMany({ where: { id: { in: [TEAM, OUTRO] } } });
});

async function conversaSemContato(numero = NUMERO) {
  const c = await basePrisma.conversation.create({
    data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: numero, externalName: "Maria S." },
  });
  await basePrisma.message.create({
    data: { teamId: TEAM, conversationId: c.id, direcao: "in", tipo: "text", conteudo: "oi", providerMessageId: `${sufixo}-m-${++n}` },
  });
  return c;
}

const lista = () => como(() => listConversations(contaId));

describe("nomeCompleto", () => {
  it("junta nome e sobrenome e ignora o que está vazio", () => {
    expect(nomeCompleto("Danilo", "Silva")).toBe("Danilo Silva");
    expect(nomeCompleto(" Danilo ", null)).toBe("Danilo");
    expect(nomeCompleto("Danilo", "  ")).toBe("Danilo");
    expect(nomeCompleto(null, undefined)).toBe("");
  });
});

describe("cadastrar contato completo pela conversa", () => {
  it("cria pessoa e empresa, liga a conversa, marca como contatado e mostra o nome completo", async () => {
    const conv = await conversaSemContato();
    const r = await como(() =>
      cadastrarContatoDaConversa(conv.id, {
        person: { nome: "Maria", sobrenome: "Silva", cargo: "Produtora rural", cidade: "Sorriso", estado: "MT", areaHa: "1.250", email: "maria@fazenda.com.br" },
        company: { nome: "Fazenda Boa Vista", cnpj: null },
        papel: "dono",
      }),
    );
    expect(r).toMatchObject({ conversationId: conv.id, jaExistia: false, nome: "Maria Silva" });

    const contato = await basePrisma.contact.findUniqueOrThrow({ where: { id: r.contactId } });
    expect(contato).toMatchObject({ nome: "Maria", sobrenome: "Silva", cargo: "Produtora rural", relacionamentoStatus: "ja_conversou", origem: "whatsapp" });
    expect(await basePrisma.channelIdentifier.count({ where: { contactId: r.contactId, canal: "whatsapp", valor: NUMERO } })).toBe(1);
    expect(await basePrisma.contactCompany.count({ where: { contactId: r.contactId } })).toBe(1);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).contactId).toBe(r.contactId);

    const item = (await lista()).items.find((i) => i.id === conv.id)!;
    expect(item.displayName).toBe("Maria Silva");
    expect(item.contact).toMatchObject({ nome: "Maria", sobrenome: "Silva", relacionamentoStatus: "ja_conversou" });
  });

  it("o status escolhido vale (Cliente), e só o nome já basta", async () => {
    const conv = await conversaSemContato();
    const r = await como(() => cadastrarContatoDaConversa(conv.id, { person: { nome: "João" }, relacionamentoStatus: "cliente" }));
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: r.contactId } })).relacionamentoStatus).toBe("cliente");
    expect(r.nome).toBe("João");
  });

  it("telefone digitado diferente do da conversa: o contato fica com o digitado e a conversa é ligada a ele", async () => {
    const conv = await conversaSemContato();
    const r = await como(() => cadastrarContatoDaConversa(conv.id, { person: { nome: "Ana", sobrenome: "Lima", telefone: "+55 65 99999-1234" } }));
    expect(await basePrisma.channelIdentifier.count({ where: { contactId: r.contactId, canal: "whatsapp" } })).toBe(1);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).contactId).toBe(r.contactId);
  });

  it("número que já é de um contato: liga a conversa a ele e não cria outro nem aplica o que foi digitado", async () => {
    const existente = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria", sobrenome: "Antiga", ownerId: dono.id } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: existente.id, canal: "whatsapp", valor: NUMERO, isPrimary: true } });
    const conv = await conversaSemContato();
    const r = await como(() => cadastrarContatoDaConversa(conv.id, { person: { nome: "Outro", sobrenome: "Nome" } }));
    expect(r).toMatchObject({ contactId: existente.id, jaExistia: true, nome: "Maria Antiga" });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(1);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).contactId).toBe(existente.id);
  });

  it("conversa de outro time não existe para quem chama; leitor não escreve", async () => {
    const conv = await conversaSemContato();
    await expect(como(() => cadastrarContatoDaConversa(conv.id, { person: { nome: "X" } }), "owner", OUTRO)).rejects.toThrow(/ConversationNotFound/);
    await expect(como(() => cadastrarContatoDaConversa(conv.id, { person: { nome: "X" } }), "viewer")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(0);
  });
});

describe("nome completo na lista e na busca de conversas", () => {
  async function conversaDe(nome: string, sobrenome: string | null) {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome, sobrenome, ownerId: dono.id } });
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, contactId: c.id, lastMessageAt: new Date(), lastMessagePreview: "oi" },
    });
    return conv;
  }

  it("a lista mostra nome e sobrenome juntos; sem sobrenome mostra só o nome", async () => {
    const a = await conversaDe("Danilo", "Silva");
    const b = await conversaDe("Rita", null);
    const itens = (await lista()).items;
    expect(itens.find((i) => i.id === a.id)!.displayName).toBe("Danilo Silva");
    expect(itens.find((i) => i.id === b.id)!.displayName).toBe("Rita");
  });

  it("a busca acha pelo sobrenome e pelo nome completo", async () => {
    const a = await conversaDe("Danilo", "Silva");
    await conversaDe("Danilo", "Souza");
    const por = (busca: string) => como(() => listConversations(contaId, { busca })).then((p) => p.items.map((i) => i.id));
    expect(await por("Silva")).toEqual([a.id]);
    expect(await por("Danilo Silva")).toEqual([a.id]);
    expect((await por("danilo")).length).toBe(2);
  });
});

describe("status do contato: Cliente", () => {
  async function contato(status: "novo" | "ja_conversou" | "opt_out" = "novo", teamId = TEAM) {
    return basePrisma.contact.create({ data: { teamId, nome: "Fulano", relacionamentoStatus: status, ownerId: teamId === TEAM ? dono.id : undefined } });
  }

  it("marca como Cliente e deixa a anotação na linha do tempo", async () => {
    const c = await contato("ja_conversou");
    await como(() => setRelacionamentoStatus(c.id, "cliente"));
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).relacionamentoStatus).toBe("cliente");
    const nota = await basePrisma.activity.findFirstOrThrow({ where: { contactId: c.id, tipo: "note" } });
    expect(nota.conteudo).toBe("Status: contatado → cliente");
    expect(nota.meta).toMatchObject({ kind: "status_change", de: "ja_conversou", para: "cliente" });
  });

  it("repetir o mesmo status não cria anotação nova", async () => {
    const c = await contato("novo");
    await como(() => setRelacionamentoStatus(c.id, "cliente"));
    await como(() => setRelacionamentoStatus(c.id, "cliente"));
    expect(await basePrisma.activity.count({ where: { contactId: c.id, tipo: "note" } })).toBe(1);
  });

  it("quem pediu para sair não muda de status por aqui", async () => {
    const c = await contato("opt_out");
    await expect(como(() => setRelacionamentoStatus(c.id, "cliente"))).rejects.toThrow(/pediu para sair/);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).relacionamentoStatus).toBe("opt_out");
  });

  it("em lote: muda quem pode, conta quem já era e pula quem pediu para sair", async () => {
    const [novo, contatado, jaCliente, saiu] = [await contato("novo"), await contato("ja_conversou"), await contato("novo"), await contato("opt_out")];
    await como(() => setRelacionamentoStatus(jaCliente.id, "cliente"));
    const r = await como(() => setRelacionamentoStatusBulk([novo.id, contatado.id, jaCliente.id, saiu.id], "cliente"));
    expect(r).toEqual({ atualizados: 2, jaEstavam: 1, pulados: 1 });
    const status = async (id: string) => (await basePrisma.contact.findUniqueOrThrow({ where: { id } })).relacionamentoStatus;
    expect([await status(novo.id), await status(contatado.id), await status(jaCliente.id), await status(saiu.id)]).toEqual(["cliente", "cliente", "cliente", "opt_out"]);
  });

  it("em lote, um id de outro time derruba o lote inteiro e nada muda", async () => {
    const meu = await contato("novo");
    const alheio = await contato("novo", OUTRO);
    await expect(como(() => setRelacionamentoStatusBulk([meu.id, alheio.id], "cliente"))).rejects.toThrow(/OwnedNotFound/);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: meu.id } })).relacionamentoStatus).toBe("novo");
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: alheio.id } })).relacionamentoStatus).toBe("novo");
  });

  it("leitor não muda status", async () => {
    const c = await contato("novo");
    await expect(como(() => setRelacionamentoStatus(c.id, "cliente"), "viewer")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(() => setRelacionamentoStatusBulk([c.id], "cliente"), "viewer")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
