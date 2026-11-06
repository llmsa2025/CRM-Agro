import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { ChannelSendFailed } from "@crmagro/channels";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import { zonedTimeToUtc } from "../motor-do-dia/tz";

/**
 * Worker das Campanhas (produto §A.3): o tick envia no máximo UM, pelo controle de ritmo
 * que já existe (cota do número, limite por contato, janela), com marcas de
 * fase (item 1.2) — incerto segura, nunca reenvia. O canal é FALSO: nada sai
 * para o WhatsApp. A fila de ticks é mockada (grava o próximo agendamento).
 */
const enviados: Array<{ to: string; text?: string }> = [];
const canal = vi.hoisted(() => ({ falha: null as null | (() => never) }));
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => ({
    send: async (input: { to: string; content: { text?: string } }) => {
      if (canal.falha) canal.falha();
      enviados.push({ to: input.to, text: input.content.text });
      return { providerMessageId: `CAMP-${enviados.length}-${Math.random().toString(36).slice(2, 8)}` };
    },
  }),
}));
// "Digitando…": ponto em que o teste injeta um evento entre o claim e o envio.
const digitando = vi.hoisted(() => ({ antes: null as null | (() => Promise<void>) }));
vi.mock("../conversations/service", async (original) => ({
  ...(await original<typeof import("../conversations/service")>()),
  sendTyping: async () => {
    if (digitando.antes) await digitando.antes();
  },
}));
const proximos: Array<{ seq: number; delayMs: number; token: string }> = [];
vi.mock("./queue", () => ({
  agendarTick: async (x: { seq: number; delayMs: number; token: string }) => void proximos.push(x),
  agendarMontagemDaLista: async () => {},
  getCampaignQueue: () => ({}),
}));

const { processarTickDaCampanha, proximaJanelaDaCampanha, TickOcupado, CLAIM_VENCIDO_MS } = await import("./tick");

const TEAM = "00000000-0000-0000-0000-0000000003ae";
const OUTRO = "00000000-0000-0000-0000-0000000003af";
const sufixo = Math.random().toString(36).slice(2, 8);
const TZ = "America/Sao_Paulo";
/** Segunda, 28/09/2026, no horário de Brasília. */
const em = (h: number, m = 0, dia = 28) => zonedTimeToUtc(2026, 9, dia, h, m, TZ);
const DENTRO = em(9, 0);
const zero = () => 0;
let contaId = "";
let seq = 0;

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Campanhas tick ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  enviados.length = 0;
  proximos.length = 0;
  canal.falha = null;
  digitando.antes = null;
  const w = { teamId: TEAM };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await redisEstado().del(`flow:balde:${TEAM}`);
  const conta = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "whatsapp",
      label: "WA",
      provider: "evolution",
      externalId: `tick-${sufixo}`,
      status: "connected",
      credentials: { instance: `tick-${sufixo}` },
      dailyLimit: 400,
    },
  });
  contaId = conta.id;
});

async function campanha(extra: Record<string, unknown> = {}, destinatarios = 1) {
  const token = `tok-${seq++}`;
  const c = await basePrisma.campaign.create({
    data: {
      teamId: TEAM,
      nome: `Tick ${token}`,
      status: "sending",
      tickToken: token,
      channelAccountId: contaId,
      mensagem: "{saudacao}, {primeiro_nome|tudo bem}?",
      ...extra,
    },
  });
  const rs = [];
  for (let i = 0; i < destinatarios; i++) {
    const numero = `+55659988${String(seq).padStart(3, "0")}${i}`;
    const k = await basePrisma.contact.create({ data: { teamId: TEAM, nome: `Ana ${i}` } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: k.id, canal: "whatsapp", valor: numero, isPrimary: true } });
    await redisEstado().del(`flow:contact:${k.id}:sends`);
    rs.push(
      await basePrisma.campaignRecipient.create({
        data: { teamId: TEAM, campaignId: c.id, contactId: k.id, telefone: numero, status: "queued" },
      }),
    );
  }
  return { c, token, rs, job: { kind: "tick" as const, teamId: TEAM, campaignId: c.id, token, seq: 0 } };
}

const rodar = (job: Parameters<typeof processarTickDaCampanha>[0], agora = DENTRO, team = TEAM) =>
  runWithTeam(team, () => processarTickDaCampanha(job, { agora, aleatorio: zero }), { userId: "sistema", role: "owner" });

const destinatario = (id: string) => basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id } });
const usoHoje = async () =>
  (await basePrisma.channelAccountUsage.findMany({ where: { channelAccountId: contaId } })).reduce((n, u) => n + u.sent, 0);

describe("um tick = no máximo um envio", () => {
  it("envia pelo canal, grava a fase e o recibo, gasta a cota e o limite do contato, e agenda o próximo no intervalo", async () => {
    const { c, rs, job } = await campanha({}, 2);
    expect(await rodar(job)).toBe("enviado");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.text).toBe("Bom dia, Ana?");
    const r = await destinatario(rs[0]!.id);
    expect(r).toMatchObject({ status: "sent", variacao: 0 });
    expect(r.providerMessageId).toMatch(/^CAMP-/);
    expect(r.messageId).toBeTruthy();
    expect(r.enviandoEm).not.toBeNull();
    expect((await destinatario(rs[1]!.id)).status).toBe("queued");
    expect(await usoHoje()).toBe(1);
    expect(await redisEstado().get(`flow:contact:${rs[0]!.contactId}:sends`)).toBe("1");
    expect(proximos).toEqual([{ teamId: TEAM, campaignId: c.id, token: job.token, seq: 1, delayMs: 60_000 }]);
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).enviadosNoLote).toBe(1);
  });

  it("fila vazia → concluída, sem próximo tick", async () => {
    const { c, job } = await campanha({}, 0);
    expect(await rodar(job)).toBe("concluida");
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "done", tickToken: null });
    expect(proximos).toEqual([]);
  });

  it("corrente velha (token trocado ao pausar/retomar) sai sem enviar e sem agendar", async () => {
    const { job } = await campanha();
    expect(await rodar({ ...job, token: "outra-corrente" })).toBe("corrente_morta");
    expect(enviados).toEqual([]);
    expect(proximos).toEqual([]);
  });

  it("dois ticks ao mesmo tempo na mesma campanha: um segura a trava, o outro volta para a fila do BullMQ", async () => {
    const { job } = await campanha({}, 2);
    const r = await Promise.allSettled([rodar(job), rodar({ ...job, seq: 7 })]);
    const erros = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(erros).toHaveLength(1);
    expect(erros[0]!.reason).toBeInstanceOf(TickOcupado);
    expect(enviados).toHaveLength(1);
  });

  it("dois times: o tick de uma campanha do time A rodando no contexto do B não acha nada", async () => {
    const { job } = await campanha();
    expect(await rodar(job, DENTRO, OUTRO)).toBe("corrente_morta");
    expect(enviados).toEqual([]);
  });
});

describe("ritmo da campanha", () => {
  it("janela: no almoço espera até 13:30; antes da abertura, 08:30; sábado, segunda 08:30", async () => {
    const c = { janelaInicio: "08:30", janelaFim: "17:30", pausaAlmocoInicio: "11:30", pausaAlmocoFim: "13:30", intervaloMinS: 60, intervaloMaxS: 180, pausaLoteMinM: 15, pausaLoteMaxM: 25 };
    const cfg = { respectBusinessHours: false, businessHourStart: "08:00", businessHourEnd: "18:00", businessDays: "mon,tue,wed,thu,fri", respectHolidays: true, timezone: TZ };
    expect(proximaJanelaDaCampanha(em(12, 0), c, cfg)).toEqual(em(13, 30));
    expect(proximaJanelaDaCampanha(em(7, 0), c, cfg)).toEqual(em(8, 30));
    expect(proximaJanelaDaCampanha(em(10, 0), c, cfg)).toEqual(em(10, 0));
    expect(proximaJanelaDaCampanha(em(18, 0), c, cfg)).toEqual(em(8, 30, 29));
    expect(proximaJanelaDaCampanha(em(10, 0, 26), c, cfg)).toEqual(em(8, 30, 28)); // sábado → segunda

    const { job } = await campanha();
    expect(await rodar(job, em(12, 0))).toBe("fora_da_janela");
    expect(enviados).toEqual([]);
    expect(proximos[0]!.delayMs).toBe(90 * 60_000);
  });

  it("lote cheio → pausa de 15–25 min e zera o lote", async () => {
    const { c, job } = await campanha({ enviadosNoLote: 20 });
    expect(await rodar(job)).toBe("pausa_de_lote");
    expect(enviados).toEqual([]);
    expect(proximos[0]!.delayMs).toBe(15 * 60_000);
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).enviadosNoLote).toBe(0);
  });

  it("limite diário da campanha atingido → espera a janela de amanhã", async () => {
    const { c, job, rs } = await campanha({ limiteDiario: 1 }, 2);
    await basePrisma.campaignRecipient.update({ where: { id: rs[0]!.id }, data: { status: "sent", sentAt: DENTRO } });
    expect(await rodar(job, em(10, 0))).toBe("limite_diario");
    expect(proximos[0]!.delayMs).toBe(em(8, 30, 29).getTime() - em(10, 0).getTime());
    void c;
  });
});

describe("controle de ritmo reaproveitado (nada duplicado)", () => {
  it("limite de 3 envios automáticos por contato em 24 h: volta para a fila, sem gastar cota do número", async () => {
    const { job, rs } = await campanha();
    await redisEstado().set(`flow:contact:${rs[0]!.contactId}:sends`, "3", "PX", 3_600_000);
    expect(await rodar(job)).toBe("adiado");
    const r = await destinatario(rs[0]!.id);
    expect(r.status).toBe("queued");
    // Compara com o "agora" do tick (DENTRO), não com o relógio real: DENTRO é
    // 28/09/2026 09:00 e, a partir dessa data, `Date.now()` passava dele.
    expect(r.scheduledAt!.getTime()).toBeGreaterThan(DENTRO.getTime());
    expect(enviados).toEqual([]);
    expect(await usoHoje()).toBe(0);
  });

  it("cota do número esgotada: devolve o limite do contato, volta para a fila e o tick espera o tempo da cota", async () => {
    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { dailyLimit: 0 } });
    const { job, rs } = await campanha();
    expect(await rodar(job)).toBe("adiado");
    expect((await destinatario(rs[0]!.id)).status).toBe("queued");
    expect(await redisEstado().get(`flow:contact:${rs[0]!.contactId}:sends`)).toBe("0");
    expect(proximos[0]!.delayMs).toBeGreaterThan(60_000);
  });

  it("número caído (queda da conexão) adia; número pausado (manual/saúde) PAUSA a campanha", async () => {
    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { paused: true, status: "disconnected" } });
    const a = await campanha();
    expect(await rodar(a.job)).toBe("adiado");
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: a.c.id } })).status).toBe("sending");

    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { paused: true, status: "connected" } });
    const b = await campanha();
    expect(await rodar(b.job)).toBe("freio");
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: b.c.id } })).toMatchObject({
      status: "paused",
      pausadoMotivo: "o número foi pausado (saúde do número)",
      tickToken: null,
    });
  });

  it("contato que pediu para sair depois da lista montada é pulado, sem envio", async () => {
    const { job, rs } = await campanha();
    await basePrisma.contact.update({ where: { id: rs[0]!.contactId }, data: { relacionamentoStatus: "opt_out" } });
    expect(await rodar(job)).toBe("pulado");
    expect(await destinatario(rs[0]!.id)).toMatchObject({ status: "skipped", motivo: "pediu para sair" });
    expect(enviados).toEqual([]);
  });
});

describe("opt-out (contrato do #112)", () => {
  it("o 'pare' chegou durante o 'digitando': não envia, pula e devolve a cota e o limite", async () => {
    const { job, rs } = await campanha();
    // O "digitando" é o último passo antes do canal: o opt-out entra aqui.
    digitando.antes = async () => {
      await basePrisma.contact.update({ where: { id: rs[0]!.contactId }, data: { relacionamentoStatus: "opt_out" } });
    };
    try {
      expect(await rodar(job)).toBe("pulado");
    } finally {
      digitando.antes = null;
    }
    expect(await destinatario(rs[0]!.id)).toMatchObject({ status: "skipped", motivo: "pediu para sair", enviandoEm: null });
    expect(enviados).toEqual([]);
    expect(await usoHoje()).toBe(0);
    expect(await redisEstado().get(`flow:contact:${rs[0]!.contactId}:sends`)).toBe("0");
  });
});

describe("falha no envio (marcas de fase do item 1.2)", () => {
  it("incerto (timeout depois de mandar): SEGURA para revisão, não devolve cota e nunca reenvia", async () => {
    const { job, rs } = await campanha({}, 1);
    canal.falha = () => {
      throw new ChannelSendFailed("timeout", "unknown", false);
    };
    expect(await rodar(job)).toBe("incerto");
    expect(await destinatario(rs[0]!.id)).toMatchObject({ status: "held", motivo: "resultado incerto, conferir no WhatsApp" });
    expect(await usoHoje()).toBe(1);
    canal.falha = null;
    // O próximo tick não pega o segurado: a fila acabou.
    expect(await rodar({ ...job, seq: 1 })).toBe("concluida");
    expect(enviados).toEqual([]);
  });

  it("não saiu e dá para repetir: devolve cota e limite, volta à fila em 5 min (tentativa 1)", async () => {
    const { c, job, rs } = await campanha();
    canal.falha = () => {
      throw new ChannelSendFailed("Evolution 503", "not_sent", true);
    };
    expect(await rodar(job)).toBe("adiado");
    const r = await destinatario(rs[0]!.id);
    expect(r).toMatchObject({ status: "queued", tentativas: 1, enviandoEm: null });
    expect(r.scheduledAt!.getTime() - DENTRO.getTime()).toBe(5 * 60_000);
    expect(await usoHoje()).toBe(0);
    expect(await redisEstado().get(`flow:contact:${rs[0]!.contactId}:sends`)).toBe("0");
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).falhasSeguidas).toBe(1);
  });

  it("não saiu e não adianta repetir (número inválido): falha de vez com o motivo", async () => {
    const { job, rs } = await campanha();
    canal.falha = () => {
      throw new ChannelSendFailed("Evolution 400: number not exists", "not_sent", false);
    };
    expect(await rodar(job)).toBe("falhou");
    const r = await destinatario(rs[0]!.id);
    expect(r.status).toBe("failed");
    expect(r.motivo).toMatch(/^não saiu: /);
  });

  it("tick que morreu no meio: com a marca de envio → segurado (incerto); sem a marca → volta para a fila", async () => {
    const { job, rs } = await campanha({}, 2);
    const velho = new Date(DENTRO.getTime() - CLAIM_VENCIDO_MS - 60_000);
    await basePrisma.campaignRecipient.update({ where: { id: rs[0]!.id }, data: { status: "sending", reservadoEm: velho, enviandoEm: velho } });
    await basePrisma.campaignRecipient.update({ where: { id: rs[1]!.id }, data: { status: "sending", reservadoEm: velho } });
    expect(await rodar(job)).toBe("enviado");
    expect(await destinatario(rs[0]!.id)).toMatchObject({ status: "held", motivo: "resultado incerto, conferir no WhatsApp" });
    // O sem marca voltou para a fila e foi o enviado deste tick.
    expect((await destinatario(rs[1]!.id)).status).toBe("sent");
    expect(enviados).toHaveLength(1);
  });
});

describe("justiça e número compartilhado", () => {
  it("carga: um time com o balde esgotado (muitos passos prontos) não atrasa a campanha do vizinho", async () => {
    const { reservarVezDoTime, PASSOS_POR_MINUTO_POR_TIME } = await import("../flows/justica");
    await redisEstado().del(`flow:balde:${TEAM}`, `flow:balde:${OUTRO}`);
    // O time A gastou o minuto inteiro (fluxos + campanhas prontos ao mesmo tempo).
    for (let i = 0; i < PASSOS_POR_MINUTO_POR_TIME; i++) await reservarVezDoTime(TEAM, { agora: DENTRO.getTime() });
    const a = await campanha();
    expect(await rodar(a.job)).toBe("adiado");
    expect(enviados).toEqual([]);
    expect(proximos[0]!.delayMs).toBeGreaterThanOrEqual(5_000);
    expect(proximos[0]!.delayMs).toBeLessThan(10_000);

    // O vizinho (time B) envia na hora, no mesmo instante.
    const contaB = await basePrisma.channelAccount.create({
      data: { teamId: OUTRO, canal: "whatsapp", label: "B", provider: "evolution", externalId: `tick-b-${sufixo}`, status: "connected", credentials: { instance: `tick-b-${sufixo}` }, dailyLimit: 400 },
    });
    const kB = await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Bia" } });
    await basePrisma.channelIdentifier.create({ data: { teamId: OUTRO, contactId: kB.id, canal: "whatsapp", valor: "+5565999777001", isPrimary: true } });
    await redisEstado().del(`flow:contact:${kB.id}:sends`);
    const cB = await basePrisma.campaign.create({
      data: { teamId: OUTRO, nome: "Vizinha", status: "sending", tickToken: "tok-b", channelAccountId: contaB.id, mensagem: "Oi {primeiro_nome}" },
    });
    await basePrisma.campaignRecipient.create({ data: { teamId: OUTRO, campaignId: cB.id, contactId: kB.id, telefone: "+5565999777001" } });
    try {
      expect(await rodar({ kind: "tick", teamId: OUTRO, campaignId: cB.id, token: "tok-b", seq: 0 }, DENTRO, OUTRO)).toBe("enviado");
      expect(enviados.map((e) => e.to)).toEqual(["+5565999777001"]);
    } finally {
      await basePrisma.campaignRecipient.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.campaign.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.message.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.activity.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.conversation.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.channelIdentifier.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.contact.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.channelAccountUsage.deleteMany({ where: { teamId: OUTRO } });
      await basePrisma.channelAccount.deleteMany({ where: { teamId: OUTRO } });
      await redisEstado().del(`flow:balde:${TEAM}`, `flow:balde:${OUTRO}`);
    }
  });

  it("duas campanhas no MESMO número respeitam o intervalo mínimo entre elas", async () => {
    const a = await campanha();
    const b = await campanha();
    expect(await rodar(a.job)).toBe("enviado");
    expect(await rodar(b.job)).toBe("adiado"); // mesmo instante: o número acabou de enviar
    expect(enviados).toHaveLength(1);
    expect(proximos[1]!.delayMs).toBeGreaterThanOrEqual(60_000);
    expect(await rodar(b.job, new Date(DENTRO.getTime() + 61_000))).toBe("enviado");
    expect(enviados).toHaveLength(2);
  });
});

describe("freios", () => {
  it("N falhas seguidas → pausa com o motivo", async () => {
    const { c, job } = await campanha({ falhasSeguidas: 5 });
    expect(await rodar(job)).toBe("freio");
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: "paused",
      pausadoMotivo: "5 falhas seguidas",
    });
    expect(enviados).toEqual([]);
  });

  it("pedidos de saída acima de 3% (com base mínima de 20 envios) → pausa", async () => {
    const { c, job } = await campanha({}, 22);
    const todos = await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, select: { id: true } });
    await basePrisma.campaignRecipient.updateMany({ where: { id: { in: todos.slice(0, 20).map((t) => t.id) } }, data: { status: "sent" } });
    await basePrisma.campaignRecipient.update({ where: { id: todos[20]!.id }, data: { status: "opted_out" } });
    expect(await rodar(job)).toBe("freio");
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).pausadoMotivo).toBe(
      "pedidos de saída acima de 3% (1 de 21)",
    );
  });
});
