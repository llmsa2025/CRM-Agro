import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisCache } from "../shared/redis-cache";

/**
 * Inbox rápido e correto (item 2.2 — DP-01, DP-02, N10): prévia da última
 * mensagem na própria Conversation, lista paginada por cursor, thread com as
 * mais novas e "carregar anteriores", contador de não-lidas do time.
 *
 * Nada sai de verdade: o canal (Evolution) e a mídia são mockados, e a fila do
 * motor também (o gatilho message_received não agenda nada).
 */
vi.mock("../flows/queue", () => ({ scheduleStep: vi.fn(), getFlowQueue: () => ({}) }));
const enviados: { to: string; text?: string }[] = [];
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => ({
    send: async (input: { to: string; content: { text?: string } }) => {
      enviados.push({ to: input.to, text: input.content.text });
      return { providerMessageId: `FAKE-${enviados.length}-${Math.random().toString(36).slice(2, 8)}` };
    },
  }),
  baixarMidiaEvolution: async () => ({ ok: false, motivo: "falha" }),
}));

const { receiveInbound, sendMessage, listConversations, listarTodasAsConversas, listMessages, markRead } = await import("./service");
const { countUnreadConversations, invalidarNaoLidas, previewDaMensagem, PREVIEW_MAX } = await import("./ultima-mensagem");
const { CursorInvalido } = await import("../shared/cursor-keyset");
const { vincularConversaAoContato } = await import("./vinculo");

const TEAM = "00000000-0000-0000-0000-0000000002a1";
const OUTRO = "00000000-0000-0000-0000-0000000002a2";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `inbox-teste-${sufixo}`;
const NUMERO = "5565988881234";

let contaId = "";
let contaOutroId = "";
let contatoId = "";

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

/** O cache é fail-fast: espera a conexão para os testes de cache não caírem no "sem Redis". */
async function redisPronto() {
  const r = redisCache();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Inbox (test)"], [OUTRO, "Team Inbox B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await redisPronto();
});

beforeEach(async () => {
  enviados.length = 0;
  await limpar(TEAM);
  await limpar(OUTRO);
  // A limpeza é por fora do serviço: zera o cache do badge dos dois times.
  await invalidarNaoLidas(TEAM);
  await invalidarNaoLidas(OUTRO);
  const conta = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
  contaId = conta.id;
  const contaOutro = await basePrisma.channelAccount.create({
    data: { teamId: OUTRO, canal: "whatsapp", label: "WA B", provider: "evolution", externalId: `${INSTANCIA}-b`, status: "connected" },
  });
  contaOutroId = contaOutro.id;
  const contato = await basePrisma.contact.create({
    data: { teamId: TEAM, nome: "Lead Inbox", empresa: "Fazenda Boa", cidade: "Sorriso", estado: "MT" },
  });
  contatoId = contato.id;
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true },
  });
});

function recebida(id: string, extra: Partial<Parameters<typeof receiveInbound>[0]> = {}) {
  return {
    from: NUMERO,
    fromMe: false,
    text: "quero saber o preço",
    media: null,
    providerMessageId: `${id}-${sufixo}`,
    timestamp: null,
    name: "Lead",
    instance: INSTANCIA,
    ...extra,
  };
}

async function conversaDoContato() {
  return basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, contactId: contatoId } });
}

/** Conversa de número solto com horário fixo (para montar a ordem da lista). */
async function conversaSolta(teamId: string, accountId: string, n: number, lastMessageAt: Date | null, extra = {}) {
  return basePrisma.conversation.create({
    data: {
      teamId,
      canal: "whatsapp",
      channelAccountId: accountId,
      externalNumber: `55659${String(n).padStart(8, "0")}`,
      externalName: `Solto ${n}`,
      status: "open",
      lastMessageAt,
      ...extra,
    },
  });
}

describe("prévia da última mensagem (gravada junto do lastMessageAt)", () => {
  it("entrada e saída gravam prévia + direção; só a entrada soma não-lida", async () => {
    await receiveInbound(recebida("in-1", { text: "  oi, tudo bem?  " }));
    let conv = await conversaDoContato();
    expect(conv.lastMessagePreview).toBe("oi, tudo bem?");
    expect(conv.lastMessageDirecao).toBe("in");
    expect(conv.unreadCount).toBe(1);

    // Saída pela plataforma (canal mockado).
    await runWithTeam(TEAM, () => sendMessage(conv.id, "segue a proposta"));
    expect(enviados).toEqual([{ to: NUMERO, text: "segue a proposta" }]);
    conv = await conversaDoContato();
    expect(conv.lastMessagePreview).toBe("segue a proposta");
    expect(conv.lastMessageDirecao).toBe("out");
    expect(conv.unreadCount).toBe(1);

    // Eco `fromMe` (mandada pelo celular) também é saída e não é não-lida.
    await receiveInbound(recebida("eco-1", { fromMe: true, text: "mandei do celular" }));
    conv = await conversaDoContato();
    expect(conv.lastMessagePreview).toBe("mandei do celular");
    expect(conv.lastMessageDirecao).toBe("out");
    expect(conv.unreadCount).toBe(1);

    // O DTO da lista lê só a Conversation.
    const { items } = await runWithTeam(TEAM, () => listConversations(contaId));
    expect(items[0]?.lastMessage).toMatchObject({ conteudo: "mandei do celular", direcao: "out" });
  });

  it("mídia sem legenda vira [tipo]; texto longo é cortado", async () => {
    await receiveInbound(recebida("img-1", { text: null, media: { kind: "image", mime: "image/jpeg", fileName: null } }));
    expect((await conversaDoContato()).lastMessagePreview).toBe("[image]");
    await receiveInbound(recebida("longo-1", { text: "a".repeat(500) }));
    const p = (await conversaDoContato()).lastMessagePreview!;
    expect(p.length).toBe(PREVIEW_MAX);
    expect(p.endsWith("…")).toBe(true);
    expect(previewDaMensagem(null, "audio")).toBe("[audio]");
    expect(previewDaMensagem("", "text")).toBe("");
  });

  it("mesclar conversas (cadastro do número) leva a prévia da mais nova", async () => {
    const dele = await basePrisma.conversation.create({
      data: {
        teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, contactId: contatoId, status: "open",
        lastMessageAt: new Date("2026-09-20T10:00:00Z"), lastMessagePreview: "velha", lastMessageDirecao: "out",
      },
    });
    const solta = await conversaSolta(TEAM, contaId, 1, new Date("2026-09-20T11:00:00Z"), {
      lastMessagePreview: "nova, antes do cadastro", lastMessageDirecao: "in", unreadCount: 1,
    });
    const ficou = await runWithTeam(TEAM, () => vincularConversaAoContato(solta.id, contatoId));
    expect(ficou).toBe(dele.id);
    const conv = await basePrisma.conversation.findUniqueOrThrow({ where: { id: dele.id } });
    expect(conv).toMatchObject({ lastMessagePreview: "nova, antes do cadastro", lastMessageDirecao: "in", unreadCount: 1 });
  });

  it("mensagem ANTIGA reentregue depois não troca a prévia, mas conta como não-lida", async () => {
    await receiveInbound(recebida("nova", { text: "a mais nova" }));
    const ts = Math.floor(Date.now() / 1000) - 7200; // mandada há 2 h
    await receiveInbound(recebida("velha", { text: "a antiga", timestamp: ts }));
    const conv = await conversaDoContato();
    expect(conv.lastMessagePreview).toBe("a mais nova");
    expect(conv.unreadCount).toBe(2);
  });
});

describe("listConversations — DTO, cursor e filtros", () => {
  it("DTO traz os dados do contato para a coluna Sobre (N10)", async () => {
    await receiveInbound(recebida("dto-1"));
    const { items } = await runWithTeam(TEAM, () => listConversations(contaId));
    expect(items[0]?.contact).toEqual({
      id: contatoId,
      nome: "Lead Inbox",
      sobrenome: null,
      interesse: "nao_avaliado",
      empresa: "Fazenda Boa",
      cidade: "Sorriso",
      estado: "MT",
      relacionamentoStatus: "ja_conversou",
    });
    expect(items[0]?.numero).toBe(NUMERO);
  });

  it("cursor estável: com lastMessageAt EMPATADO e nulo, nada pula nem repete", async () => {
    const t = new Date("2026-09-20T12:00:00.000Z");
    const criadas = [];
    for (let i = 0; i < 5; i++) criadas.push(await conversaSolta(TEAM, contaId, i, t)); // empate
    for (let i = 5; i < 7; i++) criadas.push(await conversaSolta(TEAM, contaId, i, null)); // sem mensagem
    criadas.push(await conversaSolta(TEAM, contaId, 7, new Date("2026-09-21T08:00:00.000Z")));
    criadas.push(await conversaSolta(TEAM, contaId, 8, new Date("2026-09-19T08:00:00.000Z")));

    // Ordem esperada: sem mensagem no topo (como antes), depois lastMessageAt desc; empate por id desc.
    const esperado = [...criadas]
      .sort((a, b) => {
        const ta = a.lastMessageAt?.getTime() ?? Infinity;
        const tb = b.lastMessageAt?.getTime() ?? Infinity;
        return tb - ta || (a.id < b.id ? 1 : -1);
      })
      .map((c) => c.id);

    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const pagina: Awaited<ReturnType<typeof listConversations>> = await runWithTeam(TEAM, () =>
        listConversations(contaId, { take: 2, cursor }),
      );
      vistos.push(...pagina.items.map((c) => c.id));
      cursor = pagina.nextCursor;
      paginas++;
    } while (cursor && paginas < 20);

    expect(vistos).toEqual(esperado);
    expect(new Set(vistos).size).toBe(criadas.length);
  });

  it("auditoria do #76: a lista LEGADA (tela atual) devolve TODAS as conversas, não só a 1ª página", async () => {
    const base = Date.parse("2026-09-20T12:00:00.000Z");
    for (let i = 0; i < 7; i++) await conversaSolta(TEAM, contaId, i, new Date(base - i * 60_000));
    await conversaSolta(TEAM, contaId, 99, null);
    // Páginas de 3 (em produção, 500): antes a action cortava na 1ª página.
    const todas = await runWithTeam(TEAM, () => listarTodasAsConversas(contaId, { porPagina: 3 }));
    const umaPagina = await runWithTeam(TEAM, () => listConversations(contaId, { take: 500 }));
    expect(todas.map((c) => c.id)).toEqual(umaPagina.items.map((c) => c.id));
    expect(todas).toHaveLength(umaPagina.items.length);
    expect(todas.length).toBeGreaterThanOrEqual(8);
  });

  it("conversa que sobe para o topo entre páginas não repete nas seguintes", async () => {
    const base = Date.parse("2026-09-20T12:00:00.000Z");
    for (let i = 0; i < 6; i++) await conversaSolta(TEAM, contaId, i, new Date(base - i * 60_000));
    const p1 = await runWithTeam(TEAM, () => listConversations(contaId, { take: 3 }));
    // A última da lista recebe mensagem e vai para o topo.
    const ultimaId = (await basePrisma.conversation.findFirstOrThrow({
      where: { teamId: TEAM, externalNumber: "5565900000005" },
    })).id;
    await basePrisma.conversation.update({ where: { id: ultimaId }, data: { lastMessageAt: new Date(base + 60_000) } });
    const p2 = await runWithTeam(TEAM, () => listConversations(contaId, { take: 3, cursor: p1.nextCursor }));
    const ids = [...p1.items, ...p2.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p2.items.map((c) => c.id)).not.toContain(ultimaId);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
  });

  it("filtro naoLidas e busca no servidor (acha além da 1ª página)", async () => {
    for (let i = 0; i < 4; i++) {
      await conversaSolta(TEAM, contaId, i, new Date(Date.parse("2026-09-20T12:00:00Z") - i * 60_000), {
        unreadCount: i % 2,
      });
    }
    const naoLidas = await runWithTeam(TEAM, () => listConversations(contaId, { naoLidas: true }));
    expect(naoLidas.items.map((c) => c.displayName).sort()).toEqual(["Solto 1", "Solto 3"]);

    const busca = await runWithTeam(TEAM, () => listConversations(contaId, { take: 1, busca: "solto 3" }));
    expect(busca.items.map((c) => c.displayName)).toEqual(["Solto 3"]);
    const porNumero = await runWithTeam(TEAM, () => listConversations(contaId, { busca: "00000002" }));
    expect(porNumero.items.map((c) => c.displayName)).toEqual(["Solto 2"]);
  });

  it("cursor adulterado → CursorInvalido", async () => {
    await expect(runWithTeam(TEAM, () => listConversations(contaId, { cursor: "nao-e-cursor" }))).rejects.toBeInstanceOf(
      CursorInvalido,
    );
  });
});

describe("dois times — lista e não-lidas não vazam", () => {
  it("o time A não vê a conversa nem conta a não-lida do time B", async () => {
    await conversaSolta(OUTRO, contaOutroId, 1, new Date(), { unreadCount: 3 });
    await conversaSolta(TEAM, contaId, 2, new Date(), { unreadCount: 1 });

    const doOutro = await runWithTeam(TEAM, () => listConversations(contaOutroId));
    expect(doOutro.items).toHaveLength(0);
    const minhas = await runWithTeam(TEAM, () => listConversations(contaId));
    expect(minhas.items.map((c) => c.displayName)).toEqual(["Solto 2"]);

    expect(await runWithTeam(TEAM, () => countUnreadConversations())).toBe(1);
    expect(await runWithTeam(OUTRO, () => countUnreadConversations())).toBe(1);
    // Mais uma não-lida no B não muda o A (chave de cache por time).
    await conversaSolta(OUTRO, contaOutroId, 3, new Date(), { unreadCount: 1 });
    await runWithTeam(OUTRO, () => receiveInbound(recebida("b-1", { instance: `${INSTANCIA}-b`, from: "5565977770000" })));
    expect(await runWithTeam(TEAM, () => countUnreadConversations())).toBe(1);
    expect(await runWithTeam(OUTRO, () => countUnreadConversations())).toBe(3);
  });
});

describe("countUnreadConversations — cache invalidado quando o unreadCount muda", () => {
  it("mensagem recebida soma na hora; abrir a conversa zera na hora", async () => {
    expect(await runWithTeam(TEAM, () => countUnreadConversations())).toBe(0);
    await receiveInbound(recebida("u-1"));
    expect(await runWithTeam(TEAM, () => countUnreadConversations())).toBe(1);
    // Escrita por fora do serviço não invalida: prova que o valor vem do cache.
    await conversaSolta(TEAM, contaId, 9, new Date(), { unreadCount: 5 });
    expect(await runWithTeam(TEAM, () => countUnreadConversations())).toBe(1);
    await runWithTeam(TEAM, async () => markRead((await conversaDoContato()).id));
    expect(await runWithTeam(TEAM, () => countUnreadConversations())).toBe(1); // sobrou a "Solto 9"
  });
});

describe("listMessages — mais novas, em ordem cronológica, com 'carregar anteriores'", () => {
  it("pagina de trás para frente sem pular nem repetir (inclusive com horário empatado)", async () => {
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, contactId: contatoId, status: "open" },
    });
    const base = Date.parse("2026-09-20T12:00:00.000Z");
    const horarios = [0, 1, 2, 3, 3, 3, 4, 5, 6].map((m) => new Date(base + m * 60_000));
    for (const [i, createdAt] of horarios.entries()) {
      await basePrisma.message.create({
        data: { teamId: TEAM, conversationId: conv.id, direcao: "in", tipo: "text", conteudo: `m${i}`, status: "delivered", createdAt },
      });
    }
    const todas = await basePrisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });

    const ultima = await runWithTeam(TEAM, () => listMessages(conv.id, { take: 4 }));
    // As 4 mais novas, a mais nova por último.
    expect(ultima.items.map((m) => m.id)).toEqual(todas.slice(-4).map((m) => m.id));
    expect(ultima.cursorAnteriores).not.toBeNull();

    let thread = ultima.items.map((m) => m.id);
    let antesDe = ultima.cursorAnteriores;
    while (antesDe) {
      const anteriores = await runWithTeam(TEAM, () => listMessages(conv.id, { take: 4, antesDe }));
      thread = [...anteriores.items.map((m) => m.id), ...thread];
      antesDe = anteriores.cursorAnteriores;
    }
    expect(thread).toEqual(todas.map((m) => m.id));
  });

  it("mensagem nova de conversa longa aparece (antes vinham as 200 mais antigas)", async () => {
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaId, contactId: contatoId, status: "open" },
    });
    const base = Date.parse("2026-09-20T12:00:00.000Z");
    await basePrisma.message.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        teamId: TEAM,
        conversationId: conv.id,
        direcao: "in" as const,
        tipo: "text" as const,
        conteudo: `m${i}`,
        status: "delivered" as const,
        createdAt: new Date(base + i * 1000),
      })),
    });
    const { items } = await runWithTeam(TEAM, () => listMessages(conv.id));
    expect(items).toHaveLength(50);
    expect(items[49]?.conteudo).toBe("m59");
    expect(items[0]?.conteudo).toBe("m10");
    // Outro time não lê a thread.
    expect((await runWithTeam(OUTRO, () => listMessages(conv.id))).items).toHaveLength(0);
  });
});
