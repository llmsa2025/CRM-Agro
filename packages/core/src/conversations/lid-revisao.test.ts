import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

/**
 * Revisão SOMENTE LEITURA das conversas "sem número" (script
 * script de operação). Banco de TESTE; a Evolution é falsa.
 */
const { listarConversasLidParaRevisao, mascararTelefone, somenteLeitura } = await import("./lid-revisao");
const { gravarParesLid } = await import("./lid-mapa");

const TEAM = "00000000-0000-0000-0000-0000000a11f1";
const OUTRO = "00000000-0000-0000-0000-0000000a11f2";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `lid-rev-${sufixo}`;
const lidDe = (n: number) => `18446990123${String(n).padStart(4, "0")}@lid`;
let contaId = "";
let contaOutroId = "";
let contatoId = "";

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.whatsAppLid.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Time da revisão (test)"], [OUTRO, "Outro time (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});
beforeEach(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
  contaId = (await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label: "WA principal", provider: "evolution", externalId: INSTANCIA, status: "connected" } })).id;
  contaOutroId = (await basePrisma.channelAccount.create({ data: { teamId: OUTRO, canal: "whatsapp", label: "WA do outro", provider: "evolution", externalId: `${INSTANCIA}-b`, status: "connected" } })).id;
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria do Posto" } })).id;
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5566999998888", isPrimary: true } });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.team.deleteMany({ where: { id: { in: [TEAM, OUTRO] } } });
});

async function convLid(n: number, opts: { teamId?: string; conta?: string; msgs?: number; nome?: string | null } = {}) {
  const teamId = opts.teamId ?? TEAM;
  const c = await basePrisma.conversation.create({
    data: { teamId, canal: "whatsapp", channelAccountId: opts.conta ?? contaId, externalNumber: lidDe(n), nomeAgenda: opts.nome ?? null, lastMessageAt: new Date(2026, 8, 1, 12, n) },
  });
  for (let i = 0; i < (opts.msgs ?? 2); i++) {
    await basePrisma.message.create({ data: { teamId, conversationId: c.id, direcao: "in", tipo: "text", conteudo: `m${i}`, providerMessageId: `${sufixo}-${teamId.slice(-2)}-${n}-${i}` } });
  }
  return c;
}

/** Evolution falsa: o @lid pedido → o telefone (uma tabela); o resto, sem par. */
function evolutionFalsa(tabela: Record<string, string>, falha = false) {
  const fake = vi.fn(async (_u: unknown, init: RequestInit) => {
    if (falha) throw new TypeError("fetch failed");
    const jid = JSON.parse(init.body as string).where.key.remoteJid as string;
    const tel = tabela[jid];
    const records = tel ? [{ key: { remoteJid: jid, remoteJidAlt: `${tel.replace(/\D/g, "")}@s.whatsapp.net`, id: "X" } }] : [];
    return Response.json({ messages: { total: records.length, pages: 1, currentPage: 1, records } });
  });
  vi.stubGlobal("fetch", fake);
  return fake;
}

const fotografia = async () => ({
  conversas: await basePrisma.conversation.findMany({ orderBy: { id: "asc" }, where: { teamId: { in: [TEAM, OUTRO] } } }),
  mensagens: await basePrisma.message.count({ where: { teamId: { in: [TEAM, OUTRO] } } }),
  mapa: await basePrisma.whatsAppLid.findMany({ where: { teamId: { in: [TEAM, OUTRO] } }, orderBy: { id: "asc" } }),
  contatos: await basePrisma.contact.count({ where: { teamId: { in: [TEAM, OUTRO] } } }),
});

describe("revisão das conversas sem número (somente leitura)", () => {
  it("separa: com par (contato ou conversa solta), só o número e sem número, por time", async () => {
    const comContato = await convLid(1, { msgs: 3, nome: "Maria (agenda)" });
    const comSolta = await convLid(2);
    const soNumero = await convLid(3);
    const semNada = await convLid(4);
    await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: "+5565911112222" } }); // a solta
    await gravarParesLid(basePrisma, TEAM, [{ lid: lidDe(1), telefone: "+5566999998888" }], "webhook"); // pelo mapa
    const fake = evolutionFalsa({ [lidDe(2)]: "+5565911112222", [lidDe(3)]: "+5565933334444" }); // pela Evolution
    await convLid(1, { teamId: OUTRO, conta: contaOutroId }); // outro time: mesmo @lid, sem par

    const r = await listarConversasLidParaRevisao({ pausaMs: 0 });

    const por = (id: string) => [...r.comPar, ...r.soNumero, ...r.semNumero].find((l) => l.conversationId === id)!;
    expect(por(comContato.id)).toMatchObject({ fonte: "mapa", telefone: "+5566999998888", mensagens: 3, nome: "Maria (agenda)", time: "Time da revisão (test)", conta: "WA principal", destino: { tipo: "contato", nome: "Maria do Posto", conversationId: null } });
    expect(por(comSolta.id)).toMatchObject({ fonte: "evolution", telefone: "+5565911112222", destino: { tipo: "conversa_solta" } });
    expect(r.comPar.map((l) => l.conversationId).sort()).toEqual([comContato.id, comSolta.id].sort());
    expect(r.soNumero.map((l) => l.conversationId)).toEqual([soNumero.id]);
    expect(r.semNumero.map((l) => l.conversationId).sort()).toEqual([semNada.id, (await basePrisma.conversation.findFirstOrThrow({ where: { teamId: OUTRO } })).id].sort());
    // Só as conversas SEM par no mapa foram perguntadas à Evolution, uma vez cada (a 1 do time A já está no mapa).
    expect(fake).toHaveBeenCalledTimes(4); // 2, 3, 4 do time A e a 1 do outro time
    expect(r.consultasComFalha).toBe(0);
  });

  it("NÃO grava nada: conversas, mensagens, mapa e contatos ficam idênticos (nem o par descoberto na Evolution é guardado)", async () => {
    await convLid(1);
    await convLid(2);
    await gravarParesLid(basePrisma, TEAM, [{ lid: lidDe(1), telefone: "+5566999998888" }], "webhook");
    evolutionFalsa({ [lidDe(2)]: "+5566999998888" });
    const antes = await fotografia();
    await listarConversasLidParaRevisao({ pausaMs: 0 });
    expect(await fotografia()).toEqual(antes);
  });

  it("o banco recusa escrita dentro da revisão (transação READ ONLY)", async () => {
    const c = await convLid(1);
    await expect(somenteLeitura(async (tx) => tx.conversation.update({ where: { id: c.id }, data: { unreadCount: 99 } }))).rejects.toThrow(/read-only/i);
    await expect(somenteLeitura(async (tx) => tx.message.deleteMany({ where: { conversationId: c.id } }))).rejects.toThrow(/read-only/i);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: c.id } })).unreadCount).toBe(0);
    expect(await basePrisma.message.count({ where: { conversationId: c.id } })).toBe(2);
  });

  it("--sem-evolution: só o mapa, nenhuma chamada à Evolution", async () => {
    await convLid(1);
    const fake = evolutionFalsa({ [lidDe(1)]: "+5566999998888" });
    const r = await listarConversasLidParaRevisao({ consultarEvolution: false, pausaMs: 0 });
    expect(fake).not.toHaveBeenCalled();
    expect(r.semNumero).toHaveLength(1);
  });

  it("Evolution fora do ar: conta as falhas, para de insistir depois de 5 seguidas e não derruba a revisão", async () => {
    for (let i = 1; i <= 7; i++) await convLid(i);
    const fake = evolutionFalsa({}, true);
    const r = await listarConversasLidParaRevisao({ pausaMs: 0 });
    expect(fake).toHaveBeenCalledTimes(5);
    expect(r.consultasComFalha).toBe(7);
    expect(r.semNumero).toHaveLength(7);
  });

  it("filtra por time quando pedido", async () => {
    await convLid(1);
    await convLid(2, { teamId: OUTRO, conta: contaOutroId });
    evolutionFalsa({});
    const r = await listarConversasLidParaRevisao({ teamId: OUTRO, pausaMs: 0 });
    expect(r.semNumero.map((l) => l.time)).toEqual(["Outro time (test)"]);
  });

  it("mascara o telefone: reconhece, mas não mostra inteiro", () => {
    expect(mascararTelefone("+5566999998888")).toBe("+5566…8888");
    expect(mascararTelefone("1234")).toBe("…1234");
  });
});
