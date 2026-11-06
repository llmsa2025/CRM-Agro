import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXTOS_CONTATO,
  basePrisma,
  cifrarTexto,
  conferirContatosCifrados,
  decifrarTexto,
  impressaoDeContato,
  impressaoDeSufixo,
  preencherContatosCifrados,
  reverterContatosCifrados,
} from "@crmagro/db";

/**
 * Preenchimento em lotes, conferência e reversão da cifra de e-mail e telefone dos contatos
 * (packages/db/src/contatos-cifra-lotes.ts, usado pelos scripts cifrar-contatos, conferir-contatos e
 * reverter-contatos-cifrados). Banco de TESTE. As linhas aqui nascem como as "antigas" de produção: criadas
 * por `basePrisma` direto, sem nenhuma coluna nova preenchida.
 */
const TEAM = "00000000-0000-0000-0000-0000000c1f11";
const OUTRO = "00000000-0000-0000-0000-0000000c1f12";
const TEL = "+5566999887766";
const TEL_SEM_9 = "+556699887766";

function modo(m: string) {
  process.env.CONTATOS_CIFRA = m;
}

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.whatsAppLid.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

let contatoA = "";
let contatoB = "";
let contaId = "";

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team Lotes (${id.slice(-2)})` } });
});

beforeEach(async () => {
  modo("off"); // as linhas "antigas" nascem sem cifra, como em produção hoje
  await limpar(TEAM);
  await limpar(OUTRO);
  contatoA = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Ana" } })).id;
  contatoB = (await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Ana B" } })).id;
  contaId = (await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `lotes-${Math.random().toString(36).slice(2, 8)}`, status: "connected" } })).id;
});

afterEach(() => modo("off"));
afterAll(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
});

const ident = (teamId: string, contactId: string, canal: "whatsapp" | "email" | "instagram", valor: string, isPrimary = true) =>
  basePrisma.channelIdentifier.create({ data: { teamId, contactId, canal, valor, isPrimary } });

/** Popula as 5 tabelas com linhas antigas (sem cifra). */
async function popular() {
  await ident(TEAM, contatoA, "whatsapp", TEL);
  await ident(TEAM, contatoA, "email", "ana@exemplo.com");
  await ident(TEAM, contatoA, "instagram", "ana.agro");
  await ident(OUTRO, contatoB, "whatsapp", TEL);
  await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: "+5511977776666" } });
  await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: "184469901234567@lid" } });
  await basePrisma.whatsAppLid.create({ data: { teamId: TEAM, lid: "111@lid", telefone: TEL, origem: "manual" } });
  await basePrisma.call.create({ data: { teamId: TEAM, contactId: contatoA, phoneNumber: TEL, direction: "outbound", provider: "manual" } });
  const camp = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "C" } });
  await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: camp.id, contactId: contatoA, telefone: TEL } });
}

const por = <T extends { tabela: string }>(rs: T[], t: string) => rs.find((r) => r.tabela === t)!;

describe("simulação", () => {
  it("conta e não grava nada", async () => {
    await popular();
    const r = await preencherContatosCifrados({ teamId: TEAM, aplicar: false, pausaMs: 0 });
    expect(por(r, "ChannelIdentifier")).toMatchObject({ total: 2, faltavam: 2, preenchidas: 2, falhas: 0, colisoes: 0 });
    expect(por(r, "Conversation")).toMatchObject({ total: 2, faltavam: 2, preenchidas: 2 });
    expect(por(r, "WhatsAppLid")).toMatchObject({ total: 1, preenchidas: 1 });
    expect(por(r, "Call")).toMatchObject({ total: 1, preenchidas: 1 });
    expect(por(r, "CampaignRecipient")).toMatchObject({ total: 1, preenchidas: 1 });
    // nada foi gravado
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, valorCifrado: { not: null } } })).toBe(0);
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM, externalNumberHash: { not: null } } })).toBe(0);
    expect(await basePrisma.call.count({ where: { teamId: TEAM, phoneNumberCifrado: { not: null } } })).toBe(0);
  });

  it("prevê a colisão de índice (e-mail que só difere na caixa) sem gravar", async () => {
    const outro = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Outro" } })).id;
    await ident(TEAM, contatoA, "email", "x@exemplo.com");
    await ident(TEAM, outro, "email", "X@Exemplo.com");
    const r = await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: false, pausaMs: 0 });
    expect(r[0]).toMatchObject({ colisoes: 1, naoNormalizadas: 1 });
  });
});

describe("aplicar", () => {
  it("preenche cifrado e índice nas 5 tabelas, sem tocar o texto nem o updatedAt", async () => {
    await popular();
    const antes = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } });
    const r = await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    for (const t of r) expect(t).toMatchObject({ falhas: 0, colisoes: 0, mudaramNoCaminho: 0 });

    const depois = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } });
    expect(depois.map((l) => [l.valor, l.updatedAt.getTime()])).toEqual(antes.map((l) => [l.valor, l.updatedAt.getTime()]));
    const tel = depois.find((l) => l.canal === "whatsapp")!;
    expect(decifrarTexto(tel.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe(TEL);
    expect(tel.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL));
    expect(tel.valorSufixoHash).toBe(impressaoDeSufixo(TEAM, TEL));
    const mail = depois.find((l) => l.canal === "email")!;
    expect(mail.valorHash).toBe(impressaoDeContato(TEAM, "email", "ana@exemplo.com"));
    expect(mail.valorSufixoHash).toBeNull();
    // handle público: intocado
    const ig = depois.find((l) => l.canal === "instagram")!;
    expect([ig.valorCifrado, ig.valorHash]).toEqual([null, null]);
    // o outro time não foi tocado
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: OUTRO } })).valorCifrado).toBeNull();

    const solta = await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, externalNumber: "+5511977776666" } });
    expect(decifrarTexto(solta.externalNumberCifrado!, CONTEXTOS_CONTATO.conversationExternalNumber)).toBe("+5511977776666");
    expect(solta.externalNumberHash).toBe(impressaoDeContato(TEAM, "whatsapp", "+5511977776666"));
    const lid = await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, externalNumber: "184469901234567@lid" } });
    expect(lid.externalNumberCifrado).toBeNull(); // @lid fica em claro, só com índice
    expect(lid.externalNumberHash).toBe(impressaoDeContato(TEAM, "lid", "184469901234567@lid"));
    const par = await basePrisma.whatsAppLid.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(par.telefoneHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL));
    expect(decifrarTexto(par.telefoneCifrado!, CONTEXTOS_CONTATO.whatsappLidTelefone)).toBe(TEL);
    expect(decifrarTexto((await basePrisma.call.findFirstOrThrow({ where: { teamId: TEAM } })).phoneNumberCifrado!, CONTEXTOS_CONTATO.callPhoneNumber)).toBe(TEL);
    expect(decifrarTexto((await basePrisma.campaignRecipient.findFirstOrThrow({ where: { teamId: TEAM } })).telefoneCifrado!, CONTEXTOS_CONTATO.campaignRecipientTelefone)).toBe(TEL);
  });

  it("é idempotente: o segundo passe não encontra nada a fazer e não regrava o cifrado", async () => {
    await popular();
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    const antes = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } });
    const r = await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    for (const t of r) expect(t).toMatchObject({ faltavam: 0, preenchidas: 0 });
    const depois = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } });
    expect(depois.map((l) => l.valorCifrado)).toEqual(antes.map((l) => l.valorCifrado));
  });

  it("é retomável: parar no meio (limite) e rodar de novo termina o serviço sem repetir", async () => {
    for (let i = 0; i < 7; i++) await ident(TEAM, contatoA, "whatsapp", `+55119000000${i}0`, i === 0);
    const parcial = await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: true, lote: 3, limite: 4, pausaMs: 0 });
    expect(parcial[0]!.preenchidas).toBe(4);
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, valorHash: null } })).toBe(3);
    const resto = await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: true, lote: 3, pausaMs: 0 });
    expect(resto[0]).toMatchObject({ faltavam: 3, preenchidas: 3 });
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, valorHash: null } })).toBe(0);
  });

  it("não sobrescreve campo já preenchido (a escrita dupla que rodou antes vale)", async () => {
    const l = await ident(TEAM, contatoA, "whatsapp", TEL);
    const jaCifrado = cifrarTexto(TEL, CONTEXTOS_CONTATO.channelIdentifierValor);
    await basePrisma.$executeRaw`UPDATE "ChannelIdentifier" SET "valorCifrado" = ${jaCifrado} WHERE id = ${l.id}`;
    await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: true, pausaMs: 0 });
    const depois = await basePrisma.channelIdentifier.findUniqueOrThrow({ where: { id: l.id } });
    expect(depois.valorCifrado).toBe(jaCifrado); // mantido
    expect(depois.valorHash).toBe(impressaoDeContato(TEAM, "whatsapp", TEL)); // completou o que faltava
  });

  it("colisão: a segunda linha fica só com o cifrado, vai para o relatório (só o id) e o resto segue", async () => {
    const outro = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Outro" } })).id;
    const a = await ident(TEAM, contatoA, "email", "x@exemplo.com");
    const b = await ident(TEAM, outro, "email", "X@Exemplo.com");
    await ident(TEAM, outro, "whatsapp", TEL);
    const r = await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: true, pausaMs: 0 });
    expect(r[0]).toMatchObject({ colisoes: 1, falhas: 0 });
    expect(r[0]!.colisaoIds).toHaveLength(1);
    const la = await basePrisma.channelIdentifier.findUniqueOrThrow({ where: { id: a.id } });
    const lb = await basePrisma.channelIdentifier.findUniqueOrThrow({ where: { id: b.id } });
    // quem vem primeiro (pela ordem do id) fica com o índice, o outro só com o cifrado
    const [comIndice, semIndice] = r[0]!.colisaoIds[0] === b.id ? [la, lb] : [lb, la];
    expect(r[0]!.colisaoIds).toEqual([semIndice.id]);
    expect(comIndice.valorHash).toBe(impressaoDeContato(TEAM, "email", "x@exemplo.com"));
    expect(semIndice.valorHash).toBeNull();
    expect(decifrarTexto(semIndice.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe(semIndice.valor);
    // o telefone, que não colide, foi preenchido
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, canal: "whatsapp", valorHash: { not: null } } })).toBe(1);
  });

  it("legado não normalizado: cifra o texto e fica sem índice (a busca cai no texto)", async () => {
    const l = await ident(TEAM, contatoA, "whatsapp", "(66) 99988-7766");
    const r = await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: true, pausaMs: 0 });
    expect(r[0]).toMatchObject({ semIndice: 1, falhas: 0 });
    const depois = await basePrisma.channelIdentifier.findUniqueOrThrow({ where: { id: l.id } });
    expect(decifrarTexto(depois.valorCifrado!, CONTEXTOS_CONTATO.channelIdentifierValor)).toBe("(66) 99988-7766");
    expect([depois.valorHash, depois.valorSufixoHash]).toEqual([null, null]);
  });

  it("as duas variantes do 9º dígito ficam com o mesmo sufixo", async () => {
    const outro = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Outro" } })).id;
    const a = await ident(TEAM, contatoA, "whatsapp", TEL);
    const b = await ident(TEAM, outro, "whatsapp", TEL_SEM_9);
    await preencherContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"], aplicar: true, pausaMs: 0 });
    const [la, lb] = await Promise.all([a, b].map((x) => basePrisma.channelIdentifier.findUniqueOrThrow({ where: { id: x.id } })));
    expect(la!.valorSufixoHash).toBe(lb!.valorSufixoHash);
    expect(la!.valorHash).not.toBe(lb!.valorHash);
  });

  it("a saída (log) nunca contém telefone nem e-mail", async () => {
    await popular();
    const linhas: string[] = [];
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0, lote: 1, log: (m) => linhas.push(m) });
    const tudo = linhas.join("\n");
    for (const proibido of ["5566999887766", "ana@exemplo.com", "977776666", "ana.agro", "184469901234567"]) expect(tudo).not.toContain(proibido);
    expect(linhas.length).toBeGreaterThan(0);
  });

  it("aceita --time: só o time pedido é tocado", async () => {
    await popular();
    await preencherContatosCifrados({ teamId: OUTRO, aplicar: true, pausaMs: 0 });
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: OUTRO, valorHash: { not: null } } })).toBe(1);
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, valorHash: { not: null } } })).toBe(0);
  });
});

describe("conferência", () => {
  it("depois do preenchimento tudo confere", async () => {
    await popular();
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    const c = await conferirContatosCifrados({ teamId: TEAM });
    for (const t of c) expect(t).toMatchObject({ semCifrado: 0, naoAbre: 0, diferenteDoTexto: 0, semIndice: 0, indiceErrado: 0 });
    expect(c.find((t) => t.tabela === "ChannelIdentifier")!.total).toBe(2);
  });

  it("acusa linha sem cifrado e sem índice", async () => {
    await popular();
    const c = await conferirContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier", "Call"] });
    expect(c.find((t) => t.tabela === "ChannelIdentifier")).toMatchObject({ semCifrado: 2, semIndice: 2 });
    expect(c.find((t) => t.tabela === "Call")).toMatchObject({ semCifrado: 1 });
  });

  it("acusa cifrado adulterado, de outro campo, diferente do texto, índice errado e cifrado/índice transplantado entre times", async () => {
    await popular();
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    await preencherContatosCifrados({ teamId: OUTRO, aplicar: true, pausaMs: 0 });
    const a = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, canal: "whatsapp" } });
    const mail = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, canal: "email" } });
    const deB = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: OUTRO } });
    // 1) cifrado de OUTRA coluna (não abre como esta)
    await basePrisma.$executeRaw`UPDATE "ChannelIdentifier" SET "valorCifrado" = ${cifrarTexto(TEL, CONTEXTOS_CONTATO.callPhoneNumber)} WHERE id = ${a.id}`;
    // 2) cifrado de OUTRO valor (abre, mas não é o texto)
    await basePrisma.$executeRaw`UPDATE "ChannelIdentifier" SET "valorCifrado" = ${cifrarTexto("outra-coisa@x.co", CONTEXTOS_CONTATO.channelIdentifierValor)} WHERE id = ${mail.id}`;
    // 3) transplante: o cifrado e o índice do time B colados numa linha do time A
    const ca = await conferirContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"] });
    expect(ca[0]).toMatchObject({ naoAbre: 1, diferenteDoTexto: 1 });
    await basePrisma.$executeRaw`UPDATE "ChannelIdentifier" SET "valorCifrado" = ${a.valorCifrado}, "valorHash" = ${deB.valorHash} WHERE id = ${a.id}`;
    const cb = await conferirContatosCifrados({ teamId: TEAM, tabelas: ["ChannelIdentifier"] });
    expect(cb[0]!.indiceErrado).toBeGreaterThanOrEqual(1); // o índice de B não é o recalculado com o time de A
    expect(cb[0]!.ids).toContain(a.id);
  });
});

describe("reversão", () => {
  it("simula por padrão e, com aplicar, zera só as colunas novas (o texto fica)", async () => {
    await popular();
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    const simulada = await reverterContatosCifrados({ teamId: TEAM, pausaMs: 0 });
    expect(por(simulada, "ChannelIdentifier")).toMatchObject({ comCamposNovos: 2, zeradas: 0 });
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, valorCifrado: { not: null } } })).toBe(2);

    const antes = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } });
    const r = await reverterContatosCifrados({ teamId: TEAM, aplicar: true, lote: 1, pausaMs: 0 });
    expect(por(r, "ChannelIdentifier").zeradas).toBe(2);
    expect(por(r, "Conversation").zeradas).toBe(2);
    expect(por(r, "WhatsAppLid").zeradas).toBe(1);
    expect(por(r, "Call").zeradas).toBe(1);
    expect(por(r, "CampaignRecipient").zeradas).toBe(1);
    const depois = await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } });
    expect(depois.map((l) => [l.valor, l.updatedAt.getTime()])).toEqual(antes.map((l) => [l.valor, l.updatedAt.getTime()]));
    for (const l of depois) expect([l.valorCifrado, l.valorHash, l.valorSufixoHash]).toEqual([null, null, null]);
    expect((await basePrisma.call.findFirstOrThrow({ where: { teamId: TEAM } })).phoneNumber).toBe(TEL);
    // o outro time (com campos novos) não foi tocado
    await preencherContatosCifrados({ teamId: OUTRO, aplicar: true, pausaMs: 0 });
    await reverterContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: OUTRO } })).valorHash).not.toBeNull();
  });

  it("ida e volta: preencher, reverter e preencher de novo dá o mesmo índice", async () => {
    await popular();
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    const h1 = (await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } })).map((l) => l.valorHash);
    await reverterContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    await preencherContatosCifrados({ teamId: TEAM, aplicar: true, pausaMs: 0 });
    const h2 = (await basePrisma.channelIdentifier.findMany({ where: { teamId: TEAM }, orderBy: { id: "asc" } })).map((l) => l.valorHash);
    expect(h2).toEqual(h1);
  });
});
