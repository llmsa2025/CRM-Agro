import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma, runAsSystem, runWithTeam as runWithTeamSemIdentidade } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import { EdicaoNaoPermitida, OwnedNotFound } from "../tenancy/assert-owned";
import { redisEstado } from "../shared/redis-cache";

/**
 * Unificação da conversa "sem número" (@lid) com a conversa do telefone
 *. Banco de TESTE (com-teste.sh); a
 * Evolution é FALSA (`fetch` trocado): nada vai à rede e nada é enviado.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { aplicarParLid, sugerirUnificacaoLid, unificarConversaSemNumero, ConversaJaTemNumero, ContatoSemWhatsApp, LidComOutroNumero, NumeroDoLidNaoEncontrado } =
  await import("./unificar-lid");
const { gravarParesLid, lerParesLid } = await import("./lid-mapa");
const { receiveInbound, listConversations, registerContactForConversation } = await import("./service");
const { remove: excluirContato } = await import("../contacts/service");

const TEAM = "00000000-0000-0000-0000-0000000a11d1";
const OUTRO = "00000000-0000-0000-0000-0000000a11d2";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `lid-teste-${sufixo}`;
const LID = "184469901234567@lid";
const TEL = "+5566999998888";
const DIGITOS = "5566999998888";

let contaId = "";
let contaOutroId = "";
let dono: { id: string };
let colega: { id: string };
let contato: { id: string };
let n = 0;

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.whatsAppLid.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await basePrisma.user.deleteMany({ where: w });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team LID (test)"], [OUTRO, "Team LID B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  scheduleStep.mockClear();
  await limpar(TEAM);
  await limpar(OUTRO);
  dono = await basePrisma.user.create({ data: { teamId: TEAM, name: "Dono", email: `dono-${sufixo}-${++n}@lid.dev`, role: "owner" } });
  colega = await basePrisma.user.create({ data: { teamId: TEAM, name: "Colega", email: `colega-${sufixo}-${n}@lid.dev`, role: "member" } });
  contaId = (
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected", ownerId: dono.id },
    })
  ).id;
  contaOutroId = (
    await basePrisma.channelAccount.create({
      data: { teamId: OUTRO, canal: "whatsapp", label: "WA B", provider: "evolution", externalId: `${INSTANCIA}-b`, status: "connected" },
    })
  ).id;
  contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria do Posto", ownerId: dono.id } });
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: TEL, isPrimary: true } });
  const chaves = await redisEstado().keys("wa:lid:*").catch(() => [] as string[]);
  if (chaves.length) await redisEstado().del(...chaves);
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.team.deleteMany({ where: { id: { in: [TEAM, OUTRO] } } });
});

// ─── Fábricas ────────────────────────────────────────────────────────────────

const como = <T>(fn: () => Promise<T>, quem: { id: string } = dono, role = "owner") =>
  runWithTeam(TEAM, fn, { userId: quem.id, role });
const comoSistema = <T>(fn: () => T, teamId = TEAM) => runAsSystem(teamId, fn);

async function mensagens(teamId: string, conversationId: string, qtd: number, prefixo: string, base = Date.parse("2026-09-01T12:00:00Z")) {
  for (let i = 0; i < qtd; i++) {
    await basePrisma.message.create({
      data: {
        teamId,
        conversationId,
        direcao: i % 2 ? "out" : "in",
        tipo: "text",
        conteudo: `${prefixo} ${i}`,
        providerMessageId: `${sufixo}-${prefixo}-${i}`,
        createdAt: new Date(base + i * 60_000),
      },
    });
  }
}

/** A conversa "sem número" do histórico: só o @lid, sem contato. */
async function conversaLid(opts: { teamId?: string; conta?: string; lid?: string; msgs?: number; naoLidas?: number; base?: number; prefixo?: string; nomeAgenda?: string | null } = {}) {
  const teamId = opts.teamId ?? TEAM;
  const ultima = new Date((opts.base ?? Date.parse("2026-09-01T12:00:00Z")) + ((opts.msgs ?? 2) - 1) * 60_000);
  const c = await basePrisma.conversation.create({
    data: {
      teamId,
      canal: "whatsapp",
      channelAccountId: opts.conta ?? contaId,
      externalNumber: opts.lid ?? LID,
      nomeAgenda: opts.nomeAgenda ?? null,
      unreadCount: opts.naoLidas ?? 0,
      lastMessageAt: ultima,
      lastMessagePreview: "mensagem antiga do histórico",
      lastMessageDirecao: "in",
    },
  });
  await mensagens(teamId, c.id, opts.msgs ?? 2, opts.prefixo ?? "lid", opts.base);
  return c;
}

/** A conversa do contato (a "normal", com o número). */
async function conversaDoContato(opts: { contactId?: string; msgs?: number; naoLidas?: number; base?: number; prefixo?: string; conta?: string } = {}) {
  const c = await basePrisma.conversation.create({
    data: {
      teamId: TEAM,
      canal: "whatsapp",
      channelAccountId: opts.conta ?? contaId,
      contactId: opts.contactId ?? contato.id,
      unreadCount: opts.naoLidas ?? 0,
      lastMessageAt: new Date((opts.base ?? Date.parse("2026-09-20T12:00:00Z")) + ((opts.msgs ?? 2) - 1) * 60_000),
      lastMessagePreview: "mensagem nova do número",
      lastMessageDirecao: "out",
    },
  });
  await mensagens(TEAM, c.id, opts.msgs ?? 2, opts.prefixo ?? "tel", opts.base ?? Date.parse("2026-09-20T12:00:00Z"));
  return c;
}

const conversasDaConta = (conta = contaId) => basePrisma.conversation.findMany({ where: { teamId: TEAM, channelAccountId: conta }, orderBy: { createdAt: "asc" } });
const totalMensagens = (teamId = TEAM) => basePrisma.message.count({ where: { teamId } });

/** Evolution falsa: devolve os registros cujo `remoteJid` OU `remoteJidAlt` bate com o filtro (o OU da consulta real). */
type Guardada = { remoteJid: string; remoteJidAlt?: string; id: string };
function evolutionFalsa(guardadas: Guardada[], falha = false) {
  const fake = vi.fn(async (_url: unknown, init: RequestInit) => {
    if (falha) throw new TypeError("fetch failed");
    const key = JSON.parse(init.body as string).where.key as { remoteJid?: string; remoteJidAlt?: string };
    const alvos = [key.remoteJid, key.remoteJidAlt].filter((x): x is string => !!x);
    const achadas = guardadas.filter((g) => alvos.some((a) => g.remoteJid === a || g.remoteJidAlt === a));
    return Response.json({
      messages: {
        total: achadas.length,
        pages: 1,
        currentPage: 1,
        records: achadas.map((g) => ({ key: { remoteJid: g.remoteJid, remoteJidAlt: g.remoteJidAlt, id: g.id }, messageTimestamp: 1_790_000_000 })),
      },
    });
  });
  vi.stubGlobal("fetch", fake);
  return fake;
}

// ─── Mapa @lid → telefone ────────────────────────────────────────────────────

describe("mapa @lid → telefone", () => {
  it("grava o par, repetir não duplica e par inválido é ignorado", async () => {
    expect(await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "webhook")).toBe(1);
    expect(await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "webhook")).toBe(0);
    expect(await gravarParesLid(basePrisma, TEAM, [{ lid: "5566999998888@s.whatsapp.net", telefone: TEL }, { lid: "123@lid", telefone: "abc" }], "webhook")).toBe(0);
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(1);
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "webhook" });
  });

  it("o mesmo @lid em dois times são pares independentes (nada vaza entre times)", async () => {
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "webhook");
    expect((await lerParesLid(basePrisma, OUTRO, [LID])).size).toBe(0);
    await gravarParesLid(basePrisma, OUTRO, [{ lid: LID, telefone: "+5565988887777" }], "webhook");
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)?.telefone).toBe(TEL);
    expect((await lerParesLid(basePrisma, OUTRO, [LID])).get(LID)?.telefone).toBe("+5565988887777");
  });

  it("o histórico (linha antiga) só cria: nunca troca um par que já está gravado", async () => {
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "webhook");
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: "+5565911112222" }], "historico");
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "webhook" });
  });

  it("a Evolution corrige um par; o palpite manual não sobrescreve o que veio da Evolution", async () => {
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "evolution");
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: "+5565988887777" }], "manual");
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "evolution" });
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: "+5565911112222" }], "webhook");
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: "+5565911112222", origem: "webhook" });
  });
});

// ─── aplicarParLid: o ponto em que o número é descoberto ─────────────────────

describe("aplicarParLid: junta a conversa sem número com a do telefone", () => {
  it("mescla na conversa do contato: mensagens movidas, não-lidas somadas, prévia da mais nova, conversa vazia removida", async () => {
    await conversaLid({ msgs: 3, naoLidas: 2, nomeAgenda: "Maria (agenda)" });
    const dele = await conversaDoContato({ msgs: 2, naoLidas: 1 });
    const antes = await totalMensagens();

    const r = await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));

    expect(r).toEqual([{ acao: "mesclada", conversationId: dele.id, mensagensMovidas: 3 }]);
    const conversas = await conversasDaConta();
    expect(conversas.map((c) => c.id)).toEqual([dele.id]); // a sem número sumiu
    const ficou = conversas[0]!;
    expect(ficou.unreadCount).toBe(3); // 1 + 2
    expect(ficou.nomeAgenda).toBe("Maria (agenda)"); // só PREENCHE o que faltava
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(5);
    expect(await totalMensagens()).toBe(antes); // nada se perdeu
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "webhook" });
  });

  it("a prévia da conversa que fica é a da mensagem mais NOVA (a sem número pode ser a mais nova)", async () => {
    await conversaLid({ msgs: 2, base: Date.parse("2026-09-25T12:00:00Z") });
    const dele = await conversaDoContato({ msgs: 2, base: Date.parse("2026-09-01T12:00:00Z") });
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    const ficou = await basePrisma.conversation.findUniqueOrThrow({ where: { id: dele.id } });
    expect(ficou.lastMessagePreview).toBe("mensagem antiga do histórico");
    expect(ficou.lastMessageAt?.toISOString()).toBe("2026-09-25T12:01:00.000Z");
  });

  it("repetir a unificação é idempotente: nada muda, nada duplica", async () => {
    await conversaLid({ msgs: 3 });
    const dele = await conversaDoContato({ msgs: 2 });
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    const depoisDa1 = { conversas: await conversasDaConta(), mensagens: await totalMensagens() };
    const r2 = await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    expect(r2).toEqual([]); // não há mais conversa @lid
    const r3 = await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "evolution"));
    expect(r3).toEqual([]);
    expect((await conversasDaConta()).map((c) => [c.id, c.unreadCount])).toEqual(depoisDa1.conversas.map((c) => [c.id, c.unreadCount]));
    expect(await totalMensagens()).toBe(depoisDa1.mensagens);
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(5);
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("o contato existe mas não tem conversa nesta conta: a conversa sem número vira a conversa dele", async () => {
    const lid = await conversaLid({ msgs: 2 });
    const r = await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    expect(r).toEqual([{ acao: "promovida", conversationId: lid.id, mensagensMovidas: 0 }]);
    const c = await basePrisma.conversation.findUniqueOrThrow({ where: { id: lid.id } });
    expect(c).toMatchObject({ contactId: contato.id, externalNumber: null });
    expect(await basePrisma.message.count({ where: { conversationId: lid.id } })).toBe(2);
  });

  it("ninguém tem esse número: a conversa sem número passa a ter o telefone (e volta a poder responder)", async () => {
    const lid = await conversaLid({ msgs: 2 });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    const c = await basePrisma.conversation.findUniqueOrThrow({ where: { id: lid.id } });
    expect(c).toMatchObject({ contactId: null, externalNumber: TEL });
    const item = (await comoSistema(() => listConversations(contaId))).items[0];
    expect(item?.numero).toBe(TEL); // já não é "sem número"
  });

  it("junta com a conversa SOLTA do número (sem contato), inclusive na forma sem o 9º dígito", async () => {
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId: TEAM } });
    await conversaLid({ msgs: 2 });
    const solta = await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, externalNumber: "+556699998888", unreadCount: 1 }, // sem o 9
    });
    await mensagens(TEAM, solta.id, 1, "solta");
    const r = await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    expect(r).toEqual([{ acao: "mesclada", conversationId: solta.id, mensagensMovidas: 2 }]);
    expect((await conversasDaConta()).map((c) => c.id)).toEqual([solta.id]);
  });

  it("dois times: o par de um time nunca mexe na conversa do outro (mesmo @lid)", async () => {
    const minha = await conversaLid({ msgs: 2 });
    const doOutro = await conversaLid({ teamId: OUTRO, conta: contaOutroId, msgs: 2, prefixo: "outro" });
    const antesOutro = await basePrisma.conversation.findUniqueOrThrow({ where: { id: doOutro.id } });
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    const depoisOutro = await basePrisma.conversation.findUniqueOrThrow({ where: { id: doOutro.id } });
    expect(depoisOutro).toEqual(antesOutro); // intocada: ainda sem número
    expect(await basePrisma.message.count({ where: { conversationId: doOutro.id } })).toBe(2);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: minha.id } })).externalNumber).not.toBe(LID);
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: OUTRO } })).toBe(0);
  });

  it("duas contas do mesmo time: cada uma junta DENTRO da própria conta, nunca entre contas", async () => {
    const conta2 = (
      await basePrisma.channelAccount.create({
        data: { teamId: TEAM, canal: "whatsapp", label: "WA 2", provider: "evolution", externalId: `${INSTANCIA}-2`, status: "connected", ownerId: dono.id },
      })
    ).id;
    const lid1 = await conversaLid({ msgs: 2, prefixo: "c1" });
    const lid2 = await conversaLid({ conta: conta2, msgs: 2, prefixo: "c2" });
    const dele2 = await conversaDoContato({ conta: conta2, msgs: 1, prefixo: "d2" });
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    // Conta 1: não há conversa do contato → a sem número vira a dele.
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: lid1.id } })).contactId).toBe(contato.id);
    // Conta 2: junta na do contato DA CONTA 2.
    expect(await basePrisma.conversation.findUnique({ where: { id: lid2.id } })).toBeNull();
    expect(await basePrisma.message.count({ where: { conversationId: dele2.id } })).toBe(3);
    expect(await basePrisma.message.count({ where: { conversationId: lid1.id } })).toBe(2);
  });

  it("conversa sem par: o par de OUTRO @lid não toca nela", async () => {
    const sozinha = await conversaLid({ lid: "999888777666555@lid" });
    await conversaDoContato({});
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    const c = await basePrisma.conversation.findUniqueOrThrow({ where: { id: sozinha.id } });
    expect(c).toMatchObject({ contactId: null, externalNumber: "999888777666555@lid" });
    expect(await basePrisma.message.count({ where: { conversationId: sozinha.id } })).toBe(2);
  });

  it("mensagens: a mesma mensagem do WhatsApp não existe duas vezes no time (índice único), o outro time não é tocado e mensagem sem id é preservada", async () => {
    const lid = await conversaLid({ msgs: 1, prefixo: "dup" });
    const dele = await conversaDoContato({ msgs: 1, prefixo: "tel" });
    // Duplicar o providerMessageId no MESMO time é impossível (é isso que garante "sem duplicar").
    await expect(
      basePrisma.message.create({ data: { teamId: TEAM, conversationId: dele.id, direcao: "in", tipo: "text", conteudo: "de novo", providerMessageId: `${sufixo}-dup-0` } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Outro time pode ter o mesmo id (as contas são de times diferentes) e nada dele muda.
    const convOutro = await conversaLid({ teamId: OUTRO, conta: contaOutroId, msgs: 1, prefixo: "dup" });
    // Duas mensagens SEM id do WhatsApp (ex.: nota do sistema) iguais: as duas ficam.
    for (const conv of [lid.id, dele.id]) {
      await basePrisma.message.create({ data: { teamId: TEAM, conversationId: conv, direcao: "out", tipo: "text", conteudo: "igual", createdAt: new Date("2026-09-02T00:00:00Z") } });
    }
    const antes = await totalMensagens();
    await comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook"));
    expect(await totalMensagens()).toBe(antes);
    expect(await basePrisma.message.count({ where: { conversationId: dele.id, conteudo: "igual" } })).toBe(2);
    expect(await basePrisma.message.count({ where: { conversationId: convOutro.id } })).toBe(1);
  });

  it("duas unificações ao mesmo tempo terminam com UMA conversa e sem perder mensagem", async () => {
    await conversaLid({ msgs: 4, naoLidas: 3 });
    const dele = await conversaDoContato({ msgs: 3, naoLidas: 1 });
    const antes = await totalMensagens();
    await Promise.all([
      comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook")),
      comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "evolution")),
      comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "webhook")),
      comoSistema(() => aplicarParLid({ lid: LID, telefone: TEL }, "manual")),
    ]);
    expect((await conversasDaConta()).map((c) => c.id)).toEqual([dele.id]);
    expect(await totalMensagens()).toBe(antes);
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(7);
    // As não-lidas passam UMA vez só (sem a trava, cada execução somava de novo).
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: dele.id } })).unreadCount).toBe(4);
  });

  it("sem permissão: quem só lê não unifica, e sem identidade no contexto também não", async () => {
    await conversaLid({ msgs: 2 });
    await conversaDoContato({ msgs: 1 });
    await expect(runWithTeam(TEAM, () => aplicarParLid({ lid: LID, telefone: TEL }, "manual"), { userId: "v", role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeamSemIdentidade(TEAM, () => aplicarParLid({ lid: LID, telefone: TEL }, "manual"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await conversasDaConta()).toHaveLength(2); // nada mudou
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
  });
});

// ─── A ação da tela ──────────────────────────────────────────────────────────

describe("ação da tela: Unificar com o contato", () => {
  it("sugerir: usa o mapa do time e mostra o contato e a conversa que serão juntados", async () => {
    const lid = await conversaLid({ msgs: 3 });
    await conversaDoContato({});
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "webhook");
    const s = await como(() => sugerirUnificacaoLid(lid.id));
    expect(s).toMatchObject({ aplicavel: true, telefone: TEL, fonte: "mapa", contato: { id: contato.id, nome: "Maria do Posto" }, jaTemConversa: true, mensagens: 3 });
  });

  it("sugerir: número que é de um contato de colega (que a pessoa não pode alterar) avisa em vez de oferecer a unificação", async () => {
    const contaColega = (
      await basePrisma.channelAccount.create({
        data: { teamId: TEAM, canal: "whatsapp", label: "WA colega", provider: "evolution", externalId: `${INSTANCIA}-c2`, status: "connected", ownerId: colega.id },
      })
    ).id;
    const lid = await conversaLid({ conta: contaColega, msgs: 2 });
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }], "webhook"); // o contato do TEL é do dono
    const s = await como(() => sugerirUnificacaoLid(lid.id), colega, "member");
    expect(s).toMatchObject({ aplicavel: true, telefone: TEL, contato: null, numeroDeOutraPessoa: true });
    // O dono, que pode alterar o contato, recebe a oferta normal.
    expect(await como(() => sugerirUnificacaoLid(lid.id))).toMatchObject({ contato: { id: contato.id }, numeroDeOutraPessoa: false });
  });

  it("sugerir: sem mapa, acha o par no banco da Evolution (só leitura) e não grava nada", async () => {
    const lid = await conversaLid({});
    const fake = evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "AO-VIVO" }]);
    const s = await como(() => sugerirUnificacaoLid(lid.id));
    expect(s).toMatchObject({ aplicavel: true, telefone: TEL, fonte: "evolution", contato: { id: contato.id } });
    expect(fake).toHaveBeenCalled();
    for (const chamada of fake.mock.calls) {
      const [url, init] = chamada as unknown as [string, RequestInit];
      expect(url).toContain(`/chat/findMessages/${INSTANCIA}`); // SÓ leitura
      expect(init.method).toBe("POST");
    }
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("sugerir: Evolution fora do ar não vira 'não tem número': avisa que não deu para conferir", async () => {
    const lid = await conversaLid({});
    evolutionFalsa([], true);
    const s = await como(() => sugerirUnificacaoLid(lid.id));
    expect(s).toMatchObject({ aplicavel: true, telefone: null, evolutionIndisponivel: true });
  });

  it("sugerir: conversa que já tem número não se aplica", async () => {
    const dele = await conversaDoContato({});
    expect(await como(() => sugerirUnificacaoLid(dele.id))).toMatchObject({ aplicavel: false, telefone: null });
  });

  it("unifica com o contato escolhido: junta, guarda o par como manual e devolve a conversa que ficou", async () => {
    const lid = await conversaLid({ msgs: 3, naoLidas: 1 });
    const dele = await conversaDoContato({ msgs: 2 });
    const antes = await totalMensagens();
    const r = await como(() => unificarConversaSemNumero(lid.id, { contactId: contato.id }));
    expect(r).toEqual({ acao: "mesclada", conversationId: dele.id, mensagensMovidas: 3 });
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toBeNull();
    expect(await totalMensagens()).toBe(antes);
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "manual" });
    // Repetir: a conversa sem número não existe mais (a tela mostra erro claro, nada muda).
    await expect(como(() => unificarConversaSemNumero(lid.id, { contactId: contato.id }))).rejects.toThrow("ConversationNotFound");
    expect(await totalMensagens()).toBe(antes);
  });

  it("recusa: contato sem WhatsApp, contato de outro time e conversa que já tem número", async () => {
    const lid = await conversaLid({});
    const semZap = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Sem zap", ownerId: dono.id } });
    await expect(como(() => unificarConversaSemNumero(lid.id, { contactId: semZap.id }))).rejects.toBeInstanceOf(ContatoSemWhatsApp);
    const doOutroTime = await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Alheio" } });
    await expect(como(() => unificarConversaSemNumero(lid.id, { contactId: doOutroTime.id }))).rejects.toBeInstanceOf(OwnedNotFound);
    const dele = await conversaDoContato({});
    await expect(como(() => unificarConversaSemNumero(dele.id, { contactId: contato.id }))).rejects.toBeInstanceOf(ConversaJaTemNumero);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("recusa quando o WhatsApp já disse que a conversa é de OUTRO número (não junta pessoas diferentes)", async () => {
    const lid = await conversaLid({ msgs: 2 });
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: "+5565911112222" }], "evolution");
    await conversaDoContato({});
    await expect(como(() => unificarConversaSemNumero(lid.id, { contactId: contato.id }))).rejects.toBeInstanceOf(LidComOutroNumero);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
    expect(await basePrisma.message.count({ where: { conversationId: lid.id } })).toBe(2);
  });

  it("usar o número descoberto: sem número em lugar nenhum, avisa e não muda nada (conversa sem par)", async () => {
    const lid = await conversaLid({ msgs: 2 });
    evolutionFalsa([]); // a Evolution responde, mas não conhece o par
    await expect(como(() => unificarConversaSemNumero(lid.id, { usarNumeroEncontrado: true }))).rejects.toBeInstanceOf(NumeroDoLidNaoEncontrado);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("usar o número descoberto: junta com o contato dono do número e grava o par da Evolution", async () => {
    const lid = await conversaLid({ msgs: 2 });
    const dele = await conversaDoContato({ msgs: 1 });
    evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "X" }]);
    const r = await como(() => unificarConversaSemNumero(lid.id, { usarNumeroEncontrado: true }));
    expect(r).toMatchObject({ acao: "mesclada", conversationId: dele.id });
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)?.origem).toBe("evolution");
  });

  it("usar o número descoberto: o dono do número é contato de um colega que a pessoa não vê → recusa e não grava nada", async () => {
    // Conta e conversa do COLEGA; o contato dono do número é do DONO (não compartilhado).
    const contaColega = (
      await basePrisma.channelAccount.create({
        data: { teamId: TEAM, canal: "whatsapp", label: "WA colega", provider: "evolution", externalId: `${INSTANCIA}-colega`, status: "connected", ownerId: colega.id },
      })
    ).id;
    const lid = await conversaLid({ conta: contaColega, msgs: 2 });
    evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "X" }]);
    await expect(como(() => unificarConversaSemNumero(lid.id, { usarNumeroEncontrado: true }), colega, "member")).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
    expect(await basePrisma.whatsAppLid.count({ where: { teamId: TEAM } })).toBe(0);
    // O dono (que vê e edita tudo) consegue.
    const r = await como(() => unificarConversaSemNumero(lid.id, { usarNumeroEncontrado: true }));
    expect(r.acao).toBe("promovida");
  });

  it("permissão: viewer é negado; colega sem 'ver e editar' não mexe na conversa do número alheio", async () => {
    const lid = await conversaLid({ msgs: 2 });
    await conversaDoContato({});
    await expect(como(() => unificarConversaSemNumero(lid.id, { contactId: contato.id }), { id: "v" }, "viewer")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(() => sugerirUnificacaoLid(lid.id), { id: "v" }, "viewer")).rejects.toBeInstanceOf(ForbiddenError);
    // O colega (member) NÃO é dono do número: nem vê a conversa.
    await expect(como(() => unificarConversaSemNumero(lid.id, { contactId: contato.id }), colega, "member")).rejects.toThrow("ConversationNotFound");
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
  });

  it("permissão: quem só VÊ as conversas do colega ('ver de todos') não as altera, mesmo com contato dele", async () => {
    const lid = await conversaLid({ msgs: 2 });
    // O contato é DO colega (a escrita nele seria permitida): só a conversa do número alheio o barra.
    const doColega = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Cliente do colega", ownerId: colega.id } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: doColega.id, canal: "whatsapp", valor: "+5566911110000", isPrimary: true } });
    await expect(
      runWithTeam(TEAM, () => unificarConversaSemNumero(lid.id, { contactId: doColega.id }), { userId: colega.id, role: "member", verTudoEm: ["conversas"] }),
    ).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
    // E o contato do dono, só visto pelo colega, também não: a escrita no contato é barrada.
    await conversaDoContato({});
    await expect(
      runWithTeam(TEAM, () => unificarConversaSemNumero(lid.id, { contactId: contato.id }), { userId: colega.id, role: "member", verTudoEm: ["conversas", "contatos"] }),
    ).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toMatchObject({ contactId: null, externalNumber: LID });
  });
});

describe("LGPD: excluir o contato apaga o telefone guardado no mapa e a conversa sem número dela", () => {
  it("o par @lid ↔ telefone e a conversa @lid da pessoa saem junto; a de outra pessoa fica", async () => {
    const dela = await conversaLid({ msgs: 3, prefixo: "dela" });
    const de = "111222333444555@lid";
    const deOutra = await conversaLid({ lid: de, msgs: 2, prefixo: "outra" });
    await gravarParesLid(basePrisma, TEAM, [{ lid: LID, telefone: TEL }, { lid: de, telefone: "+5565911112222" }], "webhook");
    await como(() => excluirContato(contato.id));
    expect(await basePrisma.contact.count({ where: { id: contato.id } })).toBe(0);
    expect((await lerParesLid(basePrisma, TEAM, [LID, de])).has(LID)).toBe(false);
    expect((await lerParesLid(basePrisma, TEAM, [de])).get(de)?.telefone).toBe("+5565911112222");
    expect(await basePrisma.conversation.findUnique({ where: { id: dela.id } })).toBeNull();
    expect(await basePrisma.message.count({ where: { conversationId: dela.id } })).toBe(0);
    expect(await basePrisma.conversation.findUnique({ where: { id: deOutra.id } })).not.toBeNull();
    expect(await basePrisma.message.count({ where: { conversationId: deOutra.id } })).toBe(2);
  });

  it("sem par no mapa a conversa @lid fica (não há como saber de quem é) e nada de outro time é tocado", async () => {
    const solta = await conversaLid({ msgs: 2 });
    const doOutro = await conversaLid({ teamId: OUTRO, conta: contaOutroId, msgs: 1, prefixo: "outro" });
    await gravarParesLid(basePrisma, OUTRO, [{ lid: LID, telefone: TEL }], "webhook"); // par de OUTRO time
    await como(() => excluirContato(contato.id));
    expect(await basePrisma.conversation.findUnique({ where: { id: solta.id } })).not.toBeNull();
    expect(await basePrisma.conversation.findUnique({ where: { id: doOutro.id } })).not.toBeNull();
    expect((await lerParesLid(basePrisma, OUTRO, [LID])).get(LID)?.telefone).toBe(TEL);
  });
});

describe("cadastrar contato numa conversa sem número", () => {
  it("com o telefone digitado: junta com a conversa do contato E guarda o par (manual) para não separar de novo", async () => {
    const lid = await conversaLid({ msgs: 2 });
    const dele = await conversaDoContato({ msgs: 1 });
    const r = await como(() => registerContactForConversation(lid.id, "Maria", TEL));
    expect(r).toEqual({ contactId: contato.id, conversationId: dele.id });
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(3);
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "manual" });
  });
});

// ─── receiveInbound: o ponto em que o número é descoberto ─────────────────────

function recebida(id: string, extra: Record<string, unknown> = {}) {
  return {
    from: TEL,
    fromMe: false,
    text: "oi, tudo bem?",
    media: null,
    providerMessageId: `${sufixo}-in-${id}`,
    timestamp: null,
    name: "Maria",
    instance: INSTANCIA,
    remoteJid: `${DIGITOS}@s.whatsapp.net`,
    ...extra,
  };
}

describe("receiveInbound descobre o par e unifica", () => {
  it("o webhook trouxe o @lid junto: a mensagem entra e a conversa sem número é unificada", async () => {
    await conversaLid({ msgs: 3 });
    const dele = await conversaDoContato({ msgs: 2 });
    await receiveInbound(recebida("wh-1", { remoteJid: LID }));
    expect((await conversasDaConta()).map((c) => c.id)).toEqual([dele.id]);
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(3 + 2 + 1);
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)).toEqual({ telefone: TEL, origem: "webhook" });
  });

  it("Evolution 2.3.7 (webhook só com o telefone): acha o par no banco da Evolution, unifica e não pergunta de novo", async () => {
    await conversaLid({ msgs: 3 });
    const dele = await conversaDoContato({ msgs: 2 });
    const fake = evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "AO-VIVO" }]);
    await receiveInbound(recebida("evo-1"));
    expect((await conversasDaConta()).map((c) => c.id)).toEqual([dele.id]);
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(3 + 2 + 1);
    expect((await lerParesLid(basePrisma, TEAM, [LID])).get(LID)?.origem).toBe("evolution");
    const chamadas = fake.mock.calls.length;
    expect(chamadas).toBeGreaterThan(0);
    // 2ª mensagem do mesmo telefone: já procurou (30 dias), não consulta a Evolution outra vez.
    await conversaLid({ msgs: 1, prefixo: "outra" }); // apareceu outra conversa @lid depois
    await receiveInbound(recebida("evo-2"));
    expect(fake.mock.calls.length).toBe(chamadas);
  });

  it("conta sem conversa @lid esperando não gasta consulta nenhuma na Evolution", async () => {
    await conversaDoContato({ msgs: 1 });
    const fake = evolutionFalsa([]);
    await receiveInbound(recebida("sem-lid"));
    expect(fake).not.toHaveBeenCalled();
    expect(await basePrisma.message.count({ where: { teamId: TEAM, providerMessageId: `${sufixo}-in-sem-lid` } })).toBe(1);
  });

  it("Evolution fora do ar: a mensagem é gravada do mesmo jeito e a conta descansa 5 min; depois a próxima tenta de novo", async () => {
    const lid = await conversaLid({ msgs: 2 });
    const dele = await conversaDoContato({ msgs: 1 });
    const fora = evolutionFalsa([], true);
    await receiveInbound(recebida("fora-1"));
    expect(await basePrisma.message.count({ where: { teamId: TEAM, providerMessageId: `${sufixo}-in-fora-1` } })).toBe(1);
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).not.toBeNull(); // segue separada
    const chamadas = fora.mock.calls.length;
    expect(chamadas).toBeGreaterThan(0);
    // Descanso: a mensagem seguinte não volta a bater (e a esperar 5 s) na Evolution que falhou.
    await receiveInbound(recebida("fora-2"));
    expect(fora.mock.calls.length).toBe(chamadas);
    expect(await redisEstado().exists(`wa:lid:falha:${contaId}`)).toBe(1);
    // Passou o descanso e a Evolution voltou: a próxima já unifica (a falha não deixou a marca "já procurei").
    await redisEstado().del(`wa:lid:falha:${contaId}`);
    evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "AO-VIVO" }]);
    await receiveInbound(recebida("fora-3"));
    expect(await basePrisma.conversation.findUnique({ where: { id: lid.id } })).toBeNull();
    expect(await basePrisma.message.count({ where: { conversationId: dele.id } })).toBe(1 + 3 + 2);
  });

  it("conta sem conversa @lid: a conferência no banco é feita 1 vez a cada 10 min (a mensagem seguinte nem consulta)", async () => {
    await conversaDoContato({ msgs: 1 });
    const fake = evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "X" }]);
    await receiveInbound(recebida("s1"));
    expect(fake).not.toHaveBeenCalled();
    expect(await redisEstado().exists(`wa:lid:sem-espera:${contaId}`)).toBe(1);
    // Aparece uma conversa @lid; dentro da janela a conta ainda não a conhece...
    const tardia = await conversaLid({ msgs: 1, prefixo: "tardia" });
    await receiveInbound(recebida("s2"));
    expect(fake).not.toHaveBeenCalled();
    // ...passada a janela, a próxima mensagem já procura e junta.
    await redisEstado().del(`wa:lid:sem-espera:${contaId}`);
    await receiveInbound(recebida("s3"));
    expect(await basePrisma.conversation.findUnique({ where: { id: tardia.id } })).toBeNull();
  });

  it("o par de OUTRA pessoa que a Evolution devolve não junta a conversa errada", async () => {
    const outra = await conversaLid({ msgs: 2, lid: "111222333444555@lid" });
    await conversaDoContato({ msgs: 1 });
    // Registro da Evolution é do @lid da Maria, mas a conversa esperando é de outro @lid.
    evolutionFalsa([{ remoteJid: LID, remoteJidAlt: `${DIGITOS}@s.whatsapp.net`, id: "X" }]);
    await receiveInbound(recebida("outra-pessoa"));
    expect(await basePrisma.conversation.findUnique({ where: { id: outra.id } })).toMatchObject({ contactId: null, externalNumber: "111222333444555@lid" });
  });
});
