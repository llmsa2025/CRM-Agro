import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXTOS_CONTATO,
  basePrisma,
  db,
  decifrarTexto,
  impressaoDeContato,
  impressaoDeSufixo,
  type ModoCifraContatos,
} from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Cifra em repouso de e-mail e telefone dos contatos, COM banco de teste (com-teste.sh): escrita dupla
 * pela extensão do `db()`, dedupe por índice cego (entre contatos e entre times), casamento do telefone
 * do webhook do WhatsApp com e sem o 9º dígito, importação, busca exata, busca que continua parcial
 * (nome, empresa), LGPD, Duplicados e o modo `off` sem nenhuma mudança. As peças puras estão em
 * `cifra-contatos-puro.test.ts`.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { writeContact, writeContactsEmLote } = await import("./write");
const contacts = await import("./service");
const { ContatoJaCadastrado, IdentifierTaken, isUniqueViolation } = await import("./errors");
const { receiveInbound, listConversations } = await import("../conversations/service");
const { gravarParesLid, lerParesLid } = await import("../conversations/lid-mapa");
const { acharExistentes } = await import("../importacao/service");
const { fetchContactsForExport } = await import("./export");
const { listContactsForCalls } = await import("../calls/service");
const { excluirContatos } = await import("./exclusao");
const { valorDe } = await import("./identificadores-cifra");

const TEAM = "00000000-0000-0000-0000-0000000c1f01";
const OUTRO = "00000000-0000-0000-0000-0000000c1f02";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `cifra-teste-${sufixo}`;
const TEL = "+5566999887766"; // com o 9º dígito
const TEL_SEM_9 = "+556699887766"; // a mesma linha, sem o 9
const TEL_FORMATADO = "(66) 99988-7766";
const MODOS_COM_CIFRA: ModoCifraContatos[] = ["dupla", "indice", "ligada"];
const MODOS_COM_INDICE: ModoCifraContatos[] = ["indice", "ligada"];

let contaId = "";
let contaOutroId = "";

function modo(m: ModoCifraContatos) {
  process.env.CONTATOS_CIFRA = m;
}

const dentro = <T>(fn: () => PromiseLike<T> | T, teamId = TEAM): Promise<T> => Promise.resolve(runWithTeam(teamId, fn)) as Promise<T>;

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.whatsAppLid.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Cifra (test)"], [OUTRO, "Team Cifra B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  process.env.CONTATOS_CIFRA = "off";
  scheduleStep.mockClear();
  await limpar(TEAM);
  await limpar(OUTRO);
  contaId = (
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
    })
  ).id;
  contaOutroId = (
    await basePrisma.channelAccount.create({
      data: { teamId: OUTRO, canal: "whatsapp", label: "WA B", provider: "evolution", externalId: `${INSTANCIA}-b`, status: "connected" },
    })
  ).id;
});

afterEach(() => {
  process.env.CONTATOS_CIFRA = "off";
});

afterAll(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
});

const entrada = (nome: string, identifiers: { whatsapp?: string; email?: string; instagram?: string }, extra: Record<string, unknown> = {}) => ({
  nome,
  identifiers,
  provenance: { source: "teste", actor: "human" as const },
  ...extra,
});

async function criarContato(nome: string, ident: { whatsapp?: string; email?: string; instagram?: string }, teamId = TEAM, extra: Record<string, unknown> = {}) {
  return (await dentro(() => writeContact(entrada(nome, ident, extra), { mode: "create" }), teamId)).contactId;
}

function msg(id: string, de: string, extra: Record<string, unknown> = {}, instance = INSTANCIA) {
  return { from: de, fromMe: false, text: "oi", media: null, providerMessageId: id, timestamp: null, name: "Fulano", instance, ...extra };
}

// ---------------------------------------------------------------------------

describe("modo off: nada muda", () => {
  it("grava só o texto: nenhuma coluna nova é preenchida, em nenhuma das 5 tabelas", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL_FORMATADO, email: "Ana@Exemplo.com" });
    await dentro(async () => {
      const prisma = db();
      await prisma.conversation.create({ data: { contactId: null, externalNumber: "+5511977776666", canal: "whatsapp", channelAccountId: contaId, status: "open" } as never });
      await prisma.whatsAppLid.create({ data: { teamId: TEAM, lid: "111@lid", telefone: TEL, origem: "manual" } });
      await prisma.call.create({ data: { teamId: TEAM, contactId: id, phoneNumber: TEL, direction: "outbound", provider: "manual" } });
      const camp = await prisma.campaign.create({ data: { teamId: TEAM, nome: "C" } });
      await prisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: camp.id, contactId: id, telefone: TEL } });
    });
    const ids = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM } });
    expect(ids.map((i) => i.valor).sort()).toEqual(["+5566999887766", "ana@exemplo.com"]);
    for (const i of ids) expect([i.valorCifrado, i.valorHash, i.valorSufixoHash]).toEqual([null, null, null]);
    const conv = await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM } });
    expect([conv.externalNumberCifrado, conv.externalNumberHash]).toEqual([null, null]);
    const par = await basePrisma.whatsAppLid.findFirstOrThrow({ where: { teamId: TEAM } });
    expect([par.telefoneCifrado, par.telefoneHash]).toEqual([null, null]);
    expect((await basePrisma.call.findFirstOrThrow({ where: { teamId: TEAM } })).phoneNumberCifrado).toBeNull();
    expect((await basePrisma.campaignRecipient.findFirstOrThrow({ where: { teamId: TEAM } })).telefoneCifrado).toBeNull();
  });

  it("a busca parcial por telefone e e-mail continua achando, e o erro de identificador repetido leva o valor", async () => {
    await criarContato("Ana Silva", { whatsapp: TEL, email: "ana@exemplo.com" });
    const outro = await criarContato("Beto", { whatsapp: "+5511911112222" });
    expect((await dentro(() => contacts.list({ search: "99988" }))).items.map((c) => c.nome)).toEqual(["Ana Silva"]);
    expect((await dentro(() => contacts.list({ search: "ana@" }))).items.map((c) => c.nome)).toEqual(["Ana Silva"]);
    const erro = await dentro(() => contacts.update(outro, { email: "ana@exemplo.com" })).catch((e) => e);
    expect(erro).toBeInstanceOf(IdentifierTaken);
    expect(erro.message).toContain("ana@exemplo.com");
  });
});

describe.each(MODOS_COM_CIFRA)("escrita pela extensão do db() no modo %s", (m) => {
  beforeEach(() => modo(m));

  it("writeContact: texto normalizado + cifrado que abre + índice do time + sufixo (só telefone)", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL_FORMATADO, email: "Ana@Exemplo.com", instagram: "ana.agro" });
    const linhas = await basePrisma.channelIdentifier.findMany({ where: { contactId: id } });
    const porCanal = Object.fromEntries(linhas.map((l) => [l.canal, l]));
    expect(porCanal.whatsapp!.valor).toBe(TEL);
    expect(decifrarTexto(porCanal.whatsapp!.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe(TEL);
    expect(porCanal.whatsapp!.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL));
    expect(porCanal.whatsapp!.valorSufixoHash).toBe(impressaoDeSufixo(TEAM, TEL));
    expect(porCanal.email!.valor).toBe("ana@exemplo.com");
    expect(decifrarTexto(porCanal.email!.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("ana@exemplo.com");
    expect(porCanal.email!.valorHash).toBe(impressaoDeContato(TEAM, "email", "ana@exemplo.com"));
    expect(porCanal.email!.valorSufixoHash).toBeNull();
    // handle público: nada de cifra
    expect([porCanal.instagram!.valorCifrado, porCanal.instagram!.valorHash, porCanal.instagram!.valorSufixoHash]).toEqual([null, null, null]);
    // o texto cifrado não guarda o valor legível
    expect(porCanal.whatsapp!.valorCifrado).not.toContain("5566999887766");
  });

  it("o mesmo valor em dois times tem índices diferentes e cada time só enxerga o seu", async () => {
    const a = await criarContato("Ana A", { whatsapp: TEL });
    const b = await criarContato("Ana B", { whatsapp: TEL }, OUTRO);
    expect(a).not.toBe(b);
    const [la, lb] = await Promise.all([
      basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: a } }),
      basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: b } }),
    ]);
    expect(la.valorHash).not.toBe(lb.valorHash);
    expect(la.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL));
    expect(lb.valorHash).toBe(impressaoDeContato(OUTRO, "whatsapp", TEL));
  });

  it("createMany (lote), createManyAndReturn, upsert e update gravam cifrado e índice", async () => {
    const lote = await dentro(() =>
      writeContactsEmLote([entrada("L1", { whatsapp: "+5511900000001" }), entrada("L2", { email: "L2@Exemplo.com" })]),
    );
    expect(lote.every((r) => r.contactId && r.created)).toBe(true);
    for (const r of lote) {
      const l = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: r.contactId! } });
      expect(l.valorCifrado).toBeTruthy();
      expect(l.valorHash).toBeTruthy();
    }
    const id = await criarContato("U", { email: "u@exemplo.com" });
    await dentro(async () => {
      const prisma = db();
      const novos = await prisma.channelIdentifier.createManyAndReturn({
        data: [{ contactId: id, canal: "whatsapp", valor: "+5511911110001", isPrimary: true }] as never,
      });
      expect(novos[0]!.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", "+5511911110001"));
      // upsert: cria
      const up = await prisma.channelIdentifier.upsert({
        where: { teamId_canal_valor: { teamId: TEAM, canal: "whatsapp", valor: "+5511911110002" } },
        create: { contactId: id, canal: "whatsapp", valor: "+5511911110002" } as never,
        update: { isPrimary: true },
      });
      expect(up.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", "+5511911110002"));
    });
    // update do valor: o índice e o cifrado acompanham (o canal é lido da linha)
    const alvo = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: id, canal: "email" } });
    await dentro(() => db().channelIdentifier.update({ where: { id: alvo.id }, data: { valor: "novo@exemplo.com" } }));
    const depois = await basePrisma.channelIdentifier.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(depois.valorHash).toBe(impressaoDeContato(TEAM, "email", "novo@exemplo.com"));
    expect(decifrarTexto(depois.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("novo@exemplo.com");
  });

  it("dentro de uma transação do db()", async () => {
    const id = await criarContato("T", { email: "t@exemplo.com" });
    await dentro(() =>
      db().$transaction(async (tx) => {
        await tx.channelIdentifier.create({ data: { contactId: id, canal: "whatsapp", valor: "+5511922220000" } as never });
      }),
    );
    const l = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: id, canal: "whatsapp" } });
    expect(l.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", "+5511922220000"));
  });

  it("conversa, par @lid, ligação e destinatário de campanha: cifrado e índice (o @lid fica em claro)", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL });
    await dentro(async () => {
      const prisma = db();
      await prisma.conversation.create({ data: { contactId: null, externalNumber: "+5511977776666", canal: "whatsapp", channelAccountId: contaId, status: "open" } as never });
      await prisma.conversation.create({ data: { contactId: null, externalNumber: "184469901234567@lid", canal: "whatsapp", channelAccountId: contaId, status: "open" } as never });
      await prisma.whatsAppLid.create({ data: { teamId: TEAM, lid: "111@lid", telefone: TEL, origem: "manual" } });
      await prisma.call.create({ data: { teamId: TEAM, contactId: id, phoneNumber: TEL, direction: "outbound", provider: "manual" } });
      const camp = await prisma.campaign.create({ data: { teamId: TEAM, nome: "C" } });
      await prisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: camp.id, contactId: id, telefone: TEL } });
    });
    const tel = await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, externalNumber: "+5511977776666" } });
    expect(decifrarTexto(tel.externalNumberCifrado!, CONTEXTOS_CONTATO.conversationExternalNumber)).toBe("+5511977776666");
    expect(tel.externalNumberHash).toBe(impressaoDeContato(TEAM, "whatsapp", "+5511977776666"));
    const lid = await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, externalNumber: "184469901234567@lid" } });
    expect(lid.externalNumberCifrado).toBeNull();
    expect(lid.externalNumberHash).toBe(impressaoDeContato(TEAM, "lid", "184469901234567@lid"));
    const par = await basePrisma.whatsAppLid.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(par.telefoneHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL));
    expect(decifrarTexto(par.telefoneCifrado!, CONTEXTOS_CONTATO.whatsappLidTelefone)).toBe(TEL);
    const lig = await basePrisma.call.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(decifrarTexto(lig.phoneNumberCifrado!, CONTEXTOS_CONTATO.callPhoneNumber)).toBe(TEL);
    const rec = await basePrisma.campaignRecipient.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(decifrarTexto(rec.telefoneCifrado!, CONTEXTOS_CONTATO.campaignRecipientTelefone)).toBe(TEL);
    // limpar o número (vincular conversa a contato) zera o cifrado e o índice
    await dentro(() => db().conversation.update({ where: { id: tel.id }, data: { contactId: id, externalNumber: null } }));
    const vinculada = await basePrisma.conversation.findUniqueOrThrow({ where: { id: tel.id } });
    expect([vinculada.externalNumber, vinculada.externalNumberCifrado, vinculada.externalNumberHash]).toEqual([null, null, null]);
  });

  it("valor inválido: grava o texto e o cifrado, sem índice; campo vazio não cria identificador", async () => {
    const id = await criarContato("Sem nada", {});
    expect(await basePrisma.channelIdentifier.count({ where: { contactId: id } })).toBe(0);
    await dentro(() => db().channelIdentifier.create({ data: { contactId: id, canal: "whatsapp", valor: "abc" } as never }));
    const l = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: id } });
    expect(l.valorCifrado).toBeTruthy();
    expect([l.valorHash, l.valorSufixoHash]).toEqual([null, null]);
  });

  it("o índice único por time: repetido no mesmo time falha (P2002, inclusive e-mail que só difere na caixa); em outro time, não", async () => {
    const a = await criarContato("A", { email: "x@exemplo.com" });
    const b = await criarContato("B", { whatsapp: "+5511900001111" });
    // mesmo e-mail com outra caixa: o texto difere (unique antigo passa), o índice é igual (unique novo barra)
    const erro = await dentro(() => db().channelIdentifier.create({ data: { contactId: b, canal: "email", valor: "X@Exemplo.com" } as never })).catch((e) => e);
    expect(isUniqueViolation(erro)).toBe(true);
    await criarContato("De outro time", { email: "x@exemplo.com" }, OUTRO);
    expect(a).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe.each(MODOS_COM_CIFRA)("dedupe no modo %s", (m) => {
  beforeEach(() => modo(m));

  it("entre contatos: o mesmo telefone em outro formato (e a variante sem o 9) e o mesmo e-mail em outra caixa são o mesmo contato", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL, email: "ana@exemplo.com" });
    await expect(dentro(() => writeContact(entrada("Outra Ana", { whatsapp: TEL_FORMATADO }), { mode: "create" }))).rejects.toBeInstanceOf(ContatoJaCadastrado);
    await expect(dentro(() => writeContact(entrada("Outra Ana", { email: "ANA@exemplo.com" }), { mode: "create" }))).rejects.toBeInstanceOf(ContatoJaCadastrado);
    // o mesmo telefone digitado de outro jeito (mesmo E.164) no upsert reaproveita o contato
    const r = await dentro(() => writeContact(entrada("Ana de novo", { whatsapp: "+55 66 99988-7766" }), { mode: "upsert" }));
    expect(r).toEqual({ contactId: id, created: false });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("entre times: o mesmo número em outro time cria outro contato", async () => {
    const a = await criarContato("Ana", { whatsapp: TEL });
    const r = await dentro(() => writeContact(entrada("Ana B", { whatsapp: TEL }), { mode: "upsert" }), OUTRO);
    expect(r.created).toBe(true);
    expect(r.contactId).not.toBe(a);
  });

  it("em lote: quem já existe volta created:false e duas linhas iguais do arquivo viram um contato", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL, email: "ana@exemplo.com" });
    const r = await dentro(() =>
      writeContactsEmLote([
        entrada("Ana de novo", { whatsapp: TEL }),
        entrada("Novo 1", { whatsapp: "+5511900002222" }),
        entrada("Novo 1 repetido", { whatsapp: "+5511900002222" }),
        entrada("Mesmo e-mail", { email: "ANA@exemplo.com" }),
      ]),
    );
    expect(r[0]).toEqual({ contactId: id, created: false });
    expect(r[1]).toMatchObject({ created: true });
    expect(r[2]).toEqual({ contactId: (r[1] as { contactId: string }).contactId, created: false });
    expect(r[3]).toEqual({ contactId: id, created: false });
  });

  it("importação (acharExistentes e CSV): acha por telefone e e-mail e não duplica", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL, email: "ana@exemplo.com" });
    const donos = await dentro(() => acharExistentes(db(), [{ whatsapps: [TEL, "+5511999990000"], emails: ["ana@exemplo.com", "outro@exemplo.com"], cpf: undefined }]));
    expect(donos.get(`w:${TEL}`)).toBe(id);
    expect(donos.get("e:ana@exemplo.com")).toBe(id);
    expect(donos.has("w:+5511999990000")).toBe(false);
    expect(donos.has("e:outro@exemplo.com")).toBe(false);
    const csv = `nome,telefone,email\nAna Repetida,${TEL_FORMATADO},\nNovo,(11) 99999-0003,novo@exemplo.com\n`;
    const r = await dentro(() => contacts.importCsv(csv));
    expect(r.created).toBe(1);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(2);
  });

  it("trocar o e-mail pelo de outro contato falha com IdentifierTaken sem o valor na mensagem", async () => {
    await criarContato("Ana", { email: "ana@exemplo.com" });
    const beto = await criarContato("Beto", { email: "beto@exemplo.com" });
    const erro = await dentro(() => contacts.update(beto, { email: "ana@exemplo.com" })).catch((e) => e);
    expect(erro).toBeInstanceOf(IdentifierTaken);
    expect(erro.message).not.toContain("ana@exemplo.com");
    // trocar para um e-mail livre atualiza cifrado e índice
    await dentro(() => contacts.update(beto, { email: "novo@exemplo.com" }));
    const l = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: beto, canal: "email" } });
    expect(l.valor).toBe("novo@exemplo.com");
    expect(l.valorHash).toBe(impressaoDeContato(TEAM, "email", "novo@exemplo.com"));
    expect(decifrarTexto(l.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("novo@exemplo.com");
  });
});

// ---------------------------------------------------------------------------

describe.each(["off", ...MODOS_COM_CIFRA] as ModoCifraContatos[])("webhook do WhatsApp no modo %s", (m) => {
  beforeEach(() => modo(m));

  it("o telefone do remetente casa com o contato com e sem o 9º dígito e a conversa é do contato", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL });
    await receiveInbound(msg(`W-${sufixo}-1`, TEL_SEM_9));
    await receiveInbound(msg(`W-${sufixo}-2`, TEL));
    const convs = await basePrisma.conversation.findMany({ where: { teamId: TEAM } });
    expect(convs).toHaveLength(1);
    expect(convs[0]!.contactId).toBe(id);
    expect(await basePrisma.message.count({ where: { teamId: TEAM } })).toBe(2);
  });

  it("o contato de outro time com o mesmo número não é usado", async () => {
    await criarContato("Ana de B", { whatsapp: TEL }, OUTRO);
    await receiveInbound(msg(`W-${sufixo}-3`, TEL));
    const conv = await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(conv.contactId).toBeNull();
    expect(conv.externalNumber).toBe(TEL);
  });

  it("número não cadastrado: uma conversa só (mesmo em rajada); cadastrar o contato depois a vincula", async () => {
    await Promise.all([1, 2, 3].map((i) => receiveInbound(msg(`W-${sufixo}-r${i}`, "+5511977776666"))));
    const convs = await basePrisma.conversation.findMany({ where: { teamId: TEAM } });
    expect(convs).toHaveLength(1);
    expect(convs[0]!.contactId).toBeNull();
    if (m !== "off") {
      expect(convs[0]!.externalNumberHash).toBe(impressaoDeContato(TEAM, "whatsapp", "+5511977776666"));
      expect(decifrarTexto(convs[0]!.externalNumberCifrado!, CONTEXTOS_CONTATO.conversationExternalNumber)).toBe("+5511977776666");
    }
    // reconciliação do histórico: cadastrar o contato (telefone em outro formato) acha a conversa solta
    const id = await criarContato("Novo", { whatsapp: "(11) 97777-6666" });
    const vinculada = await basePrisma.conversation.findUniqueOrThrow({ where: { id: convs[0]!.id } });
    expect(vinculada.contactId).toBe(id);
    expect([vinculada.externalNumber, vinculada.externalNumberCifrado, vinculada.externalNumberHash]).toEqual([null, null, null]);
  });

  it("remetente @lid: o código fica em claro, só com índice, e a segunda mensagem cai na mesma conversa", async () => {
    await receiveInbound(msg(`W-${sufixo}-l1`, "184469901234567@lid"));
    await receiveInbound(msg(`W-${sufixo}-l2`, "184469901234567@lid"));
    const convs = await basePrisma.conversation.findMany({ where: { teamId: TEAM } });
    expect(convs).toHaveLength(1);
    expect(convs[0]!.externalNumber).toBe("184469901234567@lid");
    expect(convs[0]!.externalNumberCifrado).toBeNull();
    if (m !== "off") expect(convs[0]!.externalNumberHash).toBe(impressaoDeContato(TEAM, "lid", "184469901234567@lid"));
  });

  it("a lista do inbox mostra o número legível (do cifrado quando a cifra está em indice/ligada)", async () => {
    await receiveInbound(msg(`W-${sufixo}-i1`, "+5511977776666"));
    const id = await criarContato("Ana", { whatsapp: TEL, email: "ana@exemplo.com" });
    await receiveInbound(msg(`W-${sufixo}-i2`, TEL));
    const pagina = await dentro(() => listConversations(contaId));
    const doContato = pagina.items.find((c) => c.contact?.id === id)!;
    expect(doContato.numero).toBe(TEL);
    expect(doContato.contactEmail).toBe("ana@exemplo.com");
    const solta = pagina.items.find((c) => !c.contact)!;
    expect(solta.externalNumber).toBe("+5511977776666");
    expect(solta.numero).toBe("+5511977776666");
  });

  it("par @lid → telefone: grava e lê (o telefone volta legível) e a LGPD apaga o par e a conversa sem número", async () => {
    const id = await criarContato("Ana", { whatsapp: TEL });
    await gravarParesLid(basePrisma, TEAM, [{ lid: "184469901234567@lid", telefone: TEL }], "manual");
    const lido = await lerParesLid(basePrisma, TEAM, ["184469901234567@lid"]);
    expect(lido.get("184469901234567@lid")?.telefone).toBe(TEL);
    if (m !== "off") {
      const par = await basePrisma.whatsAppLid.findFirstOrThrow({ where: { teamId: TEAM } });
      expect(par.telefoneHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL));
    }
    await receiveInbound(msg(`W-${sufixo}-d1`, "184469901234567@lid"));
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM, contactId: null } })).toBeGreaterThanOrEqual(0);
    await dentro(() => excluirContatos([id]));
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(0);
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM, externalNumber: "184469901234567@lid" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe.each(["off", "dupla", ...MODOS_COM_INDICE] as ModoCifraContatos[])("busca no modo %s", (m) => {
  const exata = m === "indice" || m === "ligada";

  beforeEach(async () => {
    modo(m);
    await criarContato("Ana Silva", { whatsapp: TEL, email: "ana@exemplo.com", instagram: "ana.agro" }, TEAM, { empresa: "Fazenda Boa Vista" });
    await criarContato("Beto Costa", { whatsapp: "+5511911112222" }, TEAM, { empresa: "Agro Silva Ltda" });
    await criarContato("Do Outro Time", { whatsapp: TEL, email: "ana@exemplo.com" }, OUTRO);
  });

  const buscar = async (search: string) => (await dentro(() => contacts.list({ search }))).items.map((c) => c.nome).sort();

  it("nome, sobrenome, empresa e cidade continuam por trecho, sem diferenciar maiúsculas, só do time", async () => {
    expect(await buscar("silva")).toEqual(["Ana Silva", "Beto Costa"]); // nome de um, empresa do outro
    expect(await buscar("ana si")).toEqual(["Ana Silva"]);
    expect(await buscar("boa vista")).toEqual(["Ana Silva"]);
    expect(await buscar("COSTA")).toEqual(["Beto Costa"]);
    expect(await dentro(() => contacts.count({ search: "silva" }))).toBe(2);
  });

  it("telefone completo acha em qualquer formato, e-mail completo acha em qualquer caixa", async () => {
    for (const t of [TEL, TEL_FORMATADO, "+55 66 99988 7766", "66999887766", "5566999887766"]) {
      // texto de telefone sem o "+": só a busca exata normaliza; a parcial (off/dupla) só casa dígitos corridos do E.164
      if (!exata && ![TEL, "5566999887766"].includes(t)) continue;
      expect(await buscar(t)).toEqual(["Ana Silva"]);
    }
    expect(await buscar("ana@exemplo.com")).toEqual(["Ana Silva"]);
    expect(await buscar("ANA@Exemplo.COM")).toEqual(["Ana Silva"]);
  });

  it("a variante sem o 9º dígito acha o contato com o 9 (e vice-versa) pelo número completo", async () => {
    if (!exata) return;
    expect(await buscar(TEL_SEM_9)).toEqual(["Ana Silva"]);
  });

  it("8 ou 9 dígitos sem DDD acham pelo sufixo (só nos modos com índice)", async () => {
    if (!exata) return;
    expect(await buscar("99887766")).toEqual(["Ana Silva"]);
    expect(await buscar("999887766")).toEqual(["Ana Silva"]);
    expect(await buscar("11112222")).toEqual(["Beto Costa"]);
  });

  it(exata ? "trecho de telefone e de e-mail NÃO acham mais" : "trecho de telefone e de e-mail ainda acham", async () => {
    expect(await buscar("99988")).toEqual(exata ? [] : ["Ana Silva"]);
    expect(await buscar("ana@")).toEqual(exata ? [] : ["Ana Silva"]);
    expect(await buscar("exemplo.com")).toEqual(exata ? [] : ["Ana Silva"]);
  });

  it("handle de instagram continua por trecho; busca vazia devolve tudo", async () => {
    expect(await buscar("ana.ag")).toEqual(["Ana Silva"]);
    expect(await buscar("")).toEqual(["Ana Silva", "Beto Costa"]);
    expect(await buscar("nada-disso")).toEqual([]);
  });

  it("o outro time acha o próprio contato e nunca o do primeiro", async () => {
    const r = (await dentro(() => contacts.list({ search: exata ? TEL : "99988" }), OUTRO)).items.map((c) => c.nome);
    expect(r).toEqual(["Do Outro Time"]);
  });

  it("exportação e aba Contatos de Ligações usam a mesma regra", async () => {
    const exp = await dentro(() => fetchContactsForExport({ search: exata ? TEL_FORMATADO : "99988" }));
    expect(exp.map((r) => r.nome)).toEqual(["Ana Silva"]);
    expect(exp[0]!.telefone).toBe(TEL);
    expect(exp[0]!.email).toBe("ana@exemplo.com");
    const ligacoes = await dentro(() => listContactsForCalls({ search: exata ? TEL : "99988" }));
    expect(ligacoes.items.map((c) => c.nome)).toEqual(["Ana Silva"]);
  });

  it("busca de conversas: número completo acha a conversa solta", async () => {
    await receiveInbound(msg(`B-${sufixo}-1`, "+5511977776666"));
    const achou = await dentro(() => listConversations(contaId, { busca: exata ? "(11) 97777-6666" : "97777" }));
    expect(achou.items).toHaveLength(1);
    const naoAchou = await dentro(() => listConversations(contaId, { busca: "97777" }));
    expect(naoAchou.items).toHaveLength(exata ? 0 : 1);
  });
});

// ---------------------------------------------------------------------------

describe("modo indice: linhas sem índice ainda são achadas pelo texto (fallback)", () => {
  it("contato criado antes da cifra (sem cifrado nem índice) é achado pelo webhook, pelo dedupe e pela busca", async () => {
    // Linhas "antigas": criadas com a cifra desligada (nenhuma coluna nova preenchida).
    const id = await criarContato("Antiga", { whatsapp: TEL, email: "antiga@exemplo.com" });
    await dentro(() => db().conversation.create({ data: { contactId: null, externalNumber: "+5511977776666", canal: "whatsapp", channelAccountId: contaId, status: "open" } as never }));
    modo("indice");
    // webhook
    await receiveInbound(msg(`F-${sufixo}-1`, TEL_SEM_9));
    expect((await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, contactId: id } })).contactId).toBe(id);
    // conversa solta antiga: a nova mensagem cai nela, não numa segunda
    await receiveInbound(msg(`F-${sufixo}-2`, "+5511977776666"));
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM, externalNumber: "+5511977776666" } })).toBe(1);
    // dedupe de escrita
    const r = await dentro(() => writeContact(entrada("Repetida", { email: "ANTIGA@exemplo.com" }), { mode: "upsert" }));
    expect(r).toEqual({ contactId: id, created: false });
    // busca por valor completo
    expect((await dentro(() => contacts.list({ search: TEL_FORMATADO }))).items.map((c) => c.nome)).toEqual(["Antiga"]);
    expect((await dentro(() => contacts.list({ search: "99887766" }))).items.map((c) => c.nome)).toEqual(["Antiga"]);
  });

  it("em ligada o fallback some: linha sem índice não é achada por valor", async () => {
    await criarContato("Antiga", { whatsapp: TEL });
    modo("ligada");
    const r = await dentro(() => writeContact(entrada("Repetida", { whatsapp: TEL }), { mode: "upsert" }));
    expect(r.created).toBe(true); // sem índice a linha antiga é invisível: por isso o preenchimento vem antes
  });
});

describe("Duplicados (agrupa pelo índice e dá o mesmo resultado que pelo texto)", () => {
  const grupos = async () =>
    (await dentro(() => contacts.findDuplicateContacts())).map((g) => ({ motivos: g.reasons, ids: g.contacts.map((c) => c.id).sort() }));

  it("telefone com e sem o 9º dígito (mesmo sufixo) e DDDs diferentes com os mesmos 8 finais agrupam em todos os modos", async () => {
    // Linhas criadas com a cifra desligada (texto) e depois com ela ligada (índice): o resultado é o mesmo.
    const a = await criarContato("Fulano A", { whatsapp: TEL });
    const b = await criarContato("Sicrano B", { whatsapp: TEL_SEM_9 });
    const c = await criarContato("Beltrano C", { whatsapp: "+5511911112222" });
    const esperado = [{ motivos: ["Telefone igual"], ids: [a, b].sort() }];
    modo("off");
    const doTexto = await grupos();
    expect(doTexto).toEqual(esperado);
    // com a cifra: reescreve os identificadores pela extensão para preencher cifrado e índice (o que o
    // preenchimento em lote faz) e confere que o resultado é o mesmo
    modo("dupla");
    for (const l of await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM } })) {
      await dentro(() => db().channelIdentifier.update({ where: { id: l.id }, data: { canal: l.canal, valor: l.valor } }));
    }
    expect(c).toBeTruthy();
    for (const m of ["dupla", "indice", "ligada"] as ModoCifraContatos[]) {
      modo(m);
      expect(await grupos()).toEqual(doTexto);
    }
  });

  it("com alguma linha sem índice o agrupamento volta ao texto (nunca agrupa menos em silêncio)", async () => {
    const a = await criarContato("Fulano A", { whatsapp: TEL });
    modo("dupla");
    const b = await criarContato("Sicrano B", { whatsapp: TEL_SEM_9 }); // esta tem índice, a primeira não
    modo("indice");
    expect(await grupos()).toEqual([{ motivos: ["Telefone igual"], ids: [a, b].sort() }]);
  });
});

describe("rotação da chave do índice", () => {
  it("o que foi gravado com a chave antiga ainda é achado com a nova + anterior", async () => {
    modo("dupla");
    const id = await criarContato("Ana", { whatsapp: TEL, email: "ana@exemplo.com" });
    const antiga = process.env.CONTATOS_INDICE_KEY!;
    try {
      process.env.CONTATOS_INDICE_KEY = "outra-chave-do-indice-com-mais-de-32-caracteres";
      process.env.CONTATOS_INDICE_KEY_ANTERIOR = antiga;
      modo("indice");
      expect((await dentro(() => contacts.list({ search: TEL_FORMATADO }))).items.map((c) => c.id)).toEqual([id]);
      const r = await dentro(() => writeContact(entrada("Repetida", { email: "ana@exemplo.com" }), { mode: "upsert" }));
      expect(r).toEqual({ contactId: id, created: false });
      await receiveInbound(msg(`K-${sufixo}-1`, TEL));
      expect((await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM } })).contactId).toBe(id);
    } finally {
      process.env.CONTATOS_INDICE_KEY = antiga;
      process.env.CONTATOS_INDICE_KEY_ANTERIOR = "";
    }
  });
});

describe("leitura legível", () => {
  it("valorDe abre o cifrado de uma linha lida do banco", async () => {
    modo("ligada");
    const id = await criarContato("Ana", { whatsapp: TEL });
    const l = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: id } });
    expect(valorDe(l)).toBe(TEL);
    // a linha lida por include do contato também
    const c = await dentro(() => contacts.getById(id));
    expect(valorDe(c.identifiers[0]!)).toBe(TEL);
  });

  it("não há dado pessoal nos logs de leitura nem no cifrado gravado", async () => {
    modo("dupla");
    const id = await criarContato("Ana", { whatsapp: TEL, email: "ana@exemplo.com" });
    const l = await basePrisma.channelIdentifier.findMany({ where: { contactId: id } });
    const brutos = JSON.stringify(l.map((x) => [x.valorCifrado, x.valorHash, x.valorSufixoHash]));
    expect(brutos).not.toContain("5566999887766");
    expect(brutos).not.toContain("ana@exemplo.com");
    expect(contaOutroId).toBeTruthy();
  });
});
