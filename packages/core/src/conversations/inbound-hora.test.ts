import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { analisarEvolutionInbound, parseEvolutionInbound, segundosDoTimestamp } from "@crmagro/channels";
import { runWithTeam } from "../test-support/identidade";

/**
 * Item 3.3 (INT-16, INT-17): hora REAL da mensagem recebida e descartes com
 * motivo. Fila do motor mockada: nenhum fluxo roda de verdade.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: vi.fn(),
  acordarPasso: vi.fn(),
  getFlowQueue: () => ({}),
}));

const { receiveInbound, dataDaMensagem, listMessages } = await import("./service");
const { acceptWhatsAppWebhook, descartesDoInbound } = await import("./inbound-queue");

const TEAM = "00000000-0000-0000-0000-0000000003a7";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `inbound-hora-${sufixo}`;
const NUMERO = "5565988881234";

let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Inbound hora (test)" } });
});

beforeEach(async () => {
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = contato.id;
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true },
  });
});

function msg(id: string, extra: Partial<Parameters<typeof receiveInbound>[0]> = {}) {
  return {
    from: NUMERO,
    fromMe: false,
    text: "oi",
    media: null,
    providerMessageId: `${sufixo}-${id}`,
    timestamp: null,
    name: "Lead",
    instance: INSTANCIA,
    ...extra,
  };
}

async function conversa() {
  return basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, contactId: contatoId } });
}

async function thread(conversationId: string) {
  const p = await runWithTeam(TEAM, () => listMessages(conversationId));
  return p.items.map((m) => m.conteudo);
}

describe("dataDaMensagem (INT-16)", () => {
  const agora = new Date("2026-09-26T12:00:10.000Z");
  const s = agora.getTime() / 1000;

  it("ao vivo: chegada dentro do segundo do timestamp → a hora da chegada (ms)", () => {
    const ts = s - 1; // 12:00:09
    expect(dataDaMensagem(ts, agora, ts * 1000 + 300).getTime()).toBe(ts * 1000 + 300);
  });

  it("chegou depois do segundo (atraso ou fila) → fim do segundo do timestamp", () => {
    const ts = s - 3600;
    expect(dataDaMensagem(ts, agora, agora.getTime()).getTime()).toBe(ts * 1000 + 999);
    // Sem `recebidoEm` (job antigo na fila): mesma regra, com agora.
    expect(dataDaMensagem(ts, agora).getTime()).toBe(ts * 1000 + 999);
  });

  it("relógio do aparelho adiantado → nunca depois de agora", () => {
    expect(dataDaMensagem(s + 3600, agora, agora.getTime()).getTime()).toBe(agora.getTime());
    expect(dataDaMensagem(s + 2, agora).getTime()).toBe(agora.getTime());
  });

  it("sem timestamp → hora da chegada (estável entre as tentativas), nunca depois de agora", () => {
    expect(dataDaMensagem(null, agora, agora.getTime() - 60_000).getTime()).toBe(agora.getTime() - 60_000);
    expect(dataDaMensagem(null, agora).getTime()).toBe(agora.getTime());
    expect(dataDaMensagem(null, agora, agora.getTime() + 5000).getTime()).toBe(agora.getTime());
  });
});

describe("segundosDoTimestamp (s × ms × Long)", () => {
  it("aceita segundos, texto, milissegundos e o Long do protobuf", () => {
    expect(segundosDoTimestamp(1790000000)).toBe(1790000000);
    expect(segundosDoTimestamp("1790000000")).toBe(1790000000);
    expect(segundosDoTimestamp(1790000000123)).toBe(1790000000);
    expect(segundosDoTimestamp({ low: 1790000000, high: 0, unsigned: false })).toBe(1790000000);
  });

  it("lixo vira null (sem derrubar a mensagem)", () => {
    expect(segundosDoTimestamp(undefined)).toBeNull();
    expect(segundosDoTimestamp("")).toBeNull();
    expect(segundosDoTimestamp("abc")).toBeNull();
    expect(segundosDoTimestamp(0)).toBeNull();
    expect(segundosDoTimestamp(12345)).toBeNull();
    expect(segundosDoTimestamp({ foo: 1 })).toBeNull();
  });
});

describe("parser: timestamp estranho e tipos (INT-17)", () => {
  const corpo = (message: unknown, extra: Record<string, unknown> = {}, jid = `${NUMERO}@s.whatsapp.net`) => ({
    event: "messages.upsert",
    instance: INSTANCIA,
    data: { key: { remoteJid: jid, id: "X1" }, message, ...extra },
  });

  it("timestamp em Long ou objeto estranho não descarta a mensagem", () => {
    const longo = parseEvolutionInbound(corpo({ conversation: "oi" }, { messageTimestamp: { low: 1790000000, high: 0 } }));
    expect(longo?.text).toBe("oi");
    expect(longo?.timestamp).toBe(1790000000);
    const estranho = parseEvolutionInbound(corpo({ conversation: "oi" }, { messageTimestamp: { foo: "bar" } }));
    expect(estranho?.text).toBe("oi");
    expect(estranho?.timestamp).toBeNull();
  });

  it("vídeo bolinha (ptv) vira mídia", () => {
    expect(parseEvolutionInbound(corpo({ ptvMessage: { mimetype: "video/mp4" } }))?.media).toEqual({
      kind: "doc",
      mime: "video/mp4",
      fileName: null,
      size: null,
    });
  });

  it("descarte diz o motivo: grupo, status, @lid sem número", () => {
    const motivo = (b: unknown) => {
      const r = analisarEvolutionInbound(b);
      return r.ok ? null : r.motivo;
    };
    expect(motivo(corpo({ conversation: "oi" }, {}, "120363000000000000@g.us"))).toBe("grupo");
    expect(motivo(corpo({ conversation: "oi" }, {}, "status@broadcast"))).toBe("nao_conversa");
    expect(motivo(corpo({ conversation: "oi" }, {}, "120363111111111111@newsletter"))).toBe("nao_conversa");
    expect(motivo(corpo({ conversation: "oi" }, {}, "123456789012345@lid"))).toBe("lid_sem_numero");
    expect(motivo({ nada: true })).toBe("payload_invalido");
  });

  it("webhook: mensagem vai para a fila com a hora de chegada; descarte é contado por motivo e tipo", async () => {
    const jobs: Array<{ kind: string; recebidoEm?: number }> = [];
    const antes = Date.now();
    const r = await acceptWhatsAppWebhook(corpo({ conversation: "oi" }), async (j) => void jobs.push(j));
    expect(r.status).toBe(200);
    expect(jobs[0]?.kind).toBe("message");
    expect(jobs[0]?.recebidoEm).toBeGreaterThanOrEqual(antes);

    const chave = "grupo:conversation";
    const n = descartesDoInbound()[chave] ?? 0;
    const g = await acceptWhatsAppWebhook(corpo({ conversation: "oi" }, {}, "120363000000000000@g.us"), async () => {});
    expect(g.body).toMatchObject({ skipped: "unparseable", motivo: "grupo" });
    expect(descartesDoInbound()[chave]).toBe(n + 1);
    const vazio = await acceptWhatsAppWebhook(corpo({ reactionMessage: { text: "👍" } }), async () => {});
    expect(vazio.body).toMatchObject({ skipped: "empty" });
    expect(descartesDoInbound()["empty:reactionMessage"]).toBeGreaterThanOrEqual(1);
  });
});

describe("receiveInbound: ordem da conversa e lastMessageAt (INT-16)", () => {
  it("resposta automática que chega no segundo seguinte fica DEPOIS da nossa mensagem", async () => {
    // Nossa mensagem saiu às T (hora em ms); a resposta automática do lead tem
    // timestamp do MESMO segundo de T e chegou 1,2 s depois.
    const T = Date.now() - 10_000;
    const ts = Math.floor(T / 1000);
    await receiveInbound(msg("a0", { text: "primeira", timestamp: ts - 60 }), { recebidoEm: T - 59_000 });
    const conv = await conversa();
    await basePrisma.message.create({
      data: { teamId: TEAM, conversationId: conv.id, direcao: "out", tipo: "text", conteudo: "nossa", status: "sent", createdAt: new Date(T) },
    });
    await receiveInbound(msg("a1", { text: "auto-resposta", timestamp: ts }), { recebidoEm: T + 1200 });
    expect(await thread(conv.id)).toEqual(["primeira", "nossa", "auto-resposta"]);
  });

  it("duas mensagens do mesmo segundo processadas fora de ordem → ficam na ordem de chegada", async () => {
    const T = Date.now() - 5_000;
    const ts = Math.floor(T / 1000);
    const base = ts * 1000;
    // O worker (concorrência 4) processa a segunda antes da primeira.
    await receiveInbound(msg("b2", { text: "segunda", timestamp: ts }), { recebidoEm: base + 700 });
    await receiveInbound(msg("b1", { text: "primeira", timestamp: ts }), { recebidoEm: base + 200 });
    expect(await thread((await conversa()).id)).toEqual(["primeira", "segunda"]);
  });

  it("mensagem antiga reentregue depois de uma queda: entra no lugar dela e não puxa a conversa", async () => {
    const agora = Date.now();
    const tsNova = Math.floor(agora / 1000) - 60;
    const tsVelha = tsNova - 3600;
    await receiveInbound(msg("c1", { text: "nova", timestamp: tsNova }), { recebidoEm: tsNova * 1000 + 100 });
    const antes = await conversa();
    // Backlog da reconexão: a mensagem de 1 h atrás só chega agora.
    await receiveInbound(msg("c0", { text: "velha", timestamp: tsVelha }), { recebidoEm: agora });
    const depois = await conversa();
    expect(depois.lastMessageAt?.getTime()).toBe(antes.lastMessageAt?.getTime()); // não andou para trás
    expect(depois.lastMessagePreview).toBe("nova");
    expect(depois.unreadCount).toBe(2); // mas conta como não-lida
    expect(await thread(depois.id)).toEqual(["velha", "nova"]);
    const velha = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, providerMessageId: `${sufixo}-c0` } });
    expect(velha.createdAt.getTime()).toBe(tsVelha * 1000 + 999);
    // A Activity (base do "respondeu?") tem a mesma hora real.
    const atividades = await basePrisma.activity.findMany({ where: { teamId: TEAM, contactId: contatoId }, orderBy: { createdAt: "asc" } });
    expect(atividades.map((a) => [a.conteudo, a.createdAt.getTime()])).toEqual([
      ["velha", tsVelha * 1000 + 999],
      ["nova", tsNova * 1000 + 100],
    ]);
  });

  it("timestamp no futuro (celular com relógio errado) → nem a mensagem nem o lastMessageAt passam de agora", async () => {
    const antes = Date.now();
    await receiveInbound(msg("d1", { text: "do futuro", timestamp: Math.floor(antes / 1000) + 86_400 }), { recebidoEm: antes });
    const depois = Date.now();
    const m = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, providerMessageId: `${sufixo}-d1` } });
    expect(m.createdAt.getTime()).toBeLessThanOrEqual(depois);
    expect((await conversa()).lastMessageAt!.getTime()).toBeLessThanOrEqual(depois);
  });
});
