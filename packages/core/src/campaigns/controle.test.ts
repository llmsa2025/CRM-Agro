import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Campanhas — iniciar, pausar, retomar, cancelar, previsão, recibo e resposta
 * (produto §A.2). Fila de ticks e fila do motor mockadas: nada é enviado.
 */
const ticks = vi.fn(async (_x: unknown) => {});
vi.mock("./queue", () => ({
  agendarTick: (x: unknown) => ticks(x),
  agendarMontagemDaLista: async () => {},
  getCampaignQueue: () => ({}),
}));
const classificar = vi.fn(async (_x: unknown) => {});
vi.mock("./classificacao", () => ({ agendarClassificacaoDaResposta: (x: unknown) => classificar(x) }));
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...a: unknown[]) => scheduleStep(...a),
  acordarPasso: vi.fn(),
  getFlowQueue: () => ({}),
}));

const { saveStep } = await import("./service");
const { startCampaign, pauseCampaign, resumeCampaign, cancelCampaign, estimate, CampaignNaoPodeIniciar, CampaignEstadoInvalido } =
  await import("./controle");
const { aplicarReciboDeCampanha, registrarRespostaDeCampanha } = await import("./resposta");
const { receiveInbound, applyStatusUpdate } = await import("../conversations/service");

const TEAM = "00000000-0000-0000-0000-0000000003ad";
const OUTRO = "00000000-0000-0000-0000-0000000003b0";
const ADMIN = { userId: "admin", role: "admin" };
const MEMBRO = { userId: "membro", role: "member" };
const VIEWER = { userId: "leitor", role: "viewer" };
const sufixo = Math.random().toString(36).slice(2, 8);
let contaId = "";
let seq = 0;

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Campanhas controle ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  ticks.mockClear();
  scheduleStep.mockClear();
  classificar.mockClear();
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const conta = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `ctl-${sufixo}`, status: "connected" },
  });
  contaId = conta.id;
});

async function contato(numero: string) {
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: `Lead ${numero.slice(-4)}` } });
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: numero, isPrimary: true } });
  return c;
}

async function campanhaPronta(extra: Record<string, unknown> = {}, naFila = 2) {
  const c = await basePrisma.campaign.create({
    data: {
      teamId: TEAM,
      nome: `Pronta ${seq++}`,
      // Campanha do time (F3): o teste é de papel (membro inicia/pausa), não de escopo.
      compartilhado: true,
      channelAccountId: contaId,
      mensagem: "{saudacao}, {primeiro_nome|tudo bem}?",
      listaOrigem: { tipo: "colados", texto: "", versao: "v1", estado: "pronta" },
      ...extra,
    },
  });
  for (let i = 0; i < naFila; i++) {
    const k = await contato(`+556599910${String(seq).padStart(2, "0")}${i}`);
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "queued" } });
  }
  return c;
}

describe("iniciar", () => {
  it("sem número, sem mensagem e sem fila: diz tudo o que falta", async () => {
    const c = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Vazia" } });
    const e = await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CampaignNaoPodeIniciar);
    expect((e as InstanceType<typeof CampaignNaoPodeIniciar>).motivos).toEqual([
      "escolha o número que envia",
      "escreva a mensagem",
      "ninguém na fila",
    ]);
    expect(ticks).not.toHaveBeenCalled();
  });

  it("número desconectado ou lista ainda montando também barram", async () => {
    const c = await campanhaPronta({ listaOrigem: { tipo: "colados", versao: "v", estado: "processando" } });
    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { status: "disconnected" } });
    const e = (await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN).catch((x: unknown) => x)) as { motivos: string[] };
    expect(e.motivos).toEqual(["o número está desconectado", "a lista ainda está sendo montada"]);
  });

  it("lista checada com outro número, ou retomada sem texto, também barram", async () => {
    const c = await campanhaPronta({
      regraJaConversou: "retomada",
      listaOrigem: { tipo: "colados", versao: "v", estado: "pronta", contaDaChecagem: "00000000-0000-0000-0000-000000000abc" },
    });
    const k = await contato("+5565999108888");
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "queued", motivo: "retomada" } });
    const e = (await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN).catch((x: unknown) => x)) as { motivos: string[] };
    expect(e.motivos).toEqual([
      "a lista foi checada com outro número: monte a lista de novo",
      "escreva o texto de retomada para quem já conversou",
    ]);
  });

  it("regra \"Nenhuma\" com retomada sobrando de uma regra antiga: inicia e manda a mensagem normal", async () => {
    const c = await campanhaPronta({ regraJaConversou: "enviar" });
    const k = await contato("+5565999108889");
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "queued", motivo: "retomada" } });
    const r = await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN);
    expect(r.status).toBe("sending");
    const d = await basePrisma.campaignRecipient.findFirst({ where: { campaignId: c.id, contactId: k.id }, select: { status: true, motivo: true } });
    expect(d).toEqual({ status: "queued", motivo: "já conversou, mensagem normal" });
  });

  it("viewer não inicia; membro inicia (decisão do dono) UMA corrente, mesmo com dois cliques", async () => {
    const c = await campanhaPronta();
    await expect(runWithTeam(TEAM, () => startCampaign(c.id), VIEWER)).rejects.toMatchObject({ name: "ForbiddenError" });
    const [a, b] = await Promise.allSettled([
      runWithTeam(TEAM, () => startCampaign(c.id), MEMBRO),
      runWithTeam(TEAM, () => startCampaign(c.id), MEMBRO),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const depois = await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(depois).toMatchObject({ status: "sending", etapa: 4 });
    expect(depois.tickToken).toBeTruthy();
    expect(depois.terminoPrevisto).not.toBeNull();
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(ticks).toHaveBeenCalledWith({ teamId: TEAM, campaignId: c.id, token: depois.tickToken, seq: 0, delayMs: 0 });
  });

  it("com início marcado no futuro fica agendada e o 1º tick espera até lá", async () => {
    const agora = new Date();
    const c = await campanhaPronta({ iniciaEm: new Date(agora.getTime() + 3_600_000) });
    const r = await runWithTeam(TEAM, () => startCampaign(c.id, agora), ADMIN);
    expect(r.status).toBe("scheduled");
    expect(ticks).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 3_600_000 }));
  });
});

describe("pausar, retomar, cancelar", () => {
  it("pausar (membro pode) mata a corrente; retomar (membro pode, viewer não) cria outra e zera as falhas", async () => {
    const c = await campanhaPronta();
    await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN);
    const antes = await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    const p = await runWithTeam(TEAM, () => pauseCampaign(c.id, "pausada pela equipe"), MEMBRO);
    expect(p).toMatchObject({ status: "paused", pausadoMotivo: "pausada pela equipe" });
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).tickToken).toBeNull();
    await expect(runWithTeam(TEAM, () => pauseCampaign(c.id, "de novo"), MEMBRO)).rejects.toBeInstanceOf(CampaignEstadoInvalido);

    await basePrisma.campaign.update({ where: { id: c.id }, data: { falhasSeguidas: 5 } });
    await expect(runWithTeam(TEAM, () => resumeCampaign(c.id), VIEWER)).rejects.toMatchObject({ name: "ForbiddenError" });
    const r = await runWithTeam(TEAM, () => resumeCampaign(c.id), MEMBRO);
    expect(r).toMatchObject({ status: "sending", falhasSeguidas: 0, pausadoMotivo: null });
    const token = (await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).tickToken;
    expect(token).toBeTruthy();
    expect(token).not.toBe(antes.tickToken);
    expect(ticks).toHaveBeenLastCalledWith({ teamId: TEAM, campaignId: c.id, token, seq: 0, delayMs: 0 });
  });

  it("cancelar: fila e segurados viram 'pulado'; enviados ficam como estão", async () => {
    const c = await campanhaPronta({}, 2);
    const k = await contato("+5565999109999");
    await basePrisma.campaignRecipient.createMany({
      data: [{ teamId: TEAM, campaignId: c.id, contactId: k.id, status: "sent", sentAt: new Date() }],
    });
    await runWithTeam(TEAM, () => cancelCampaign(c.id), MEMBRO);
    const grupos = await basePrisma.campaignRecipient.groupBy({ by: ["status", "motivo"], where: { campaignId: c.id }, _count: { _all: true } });
    expect(grupos.map((g) => [g.status, g.motivo, g._count._all]).sort()).toEqual([
      ["sent", null, 1],
      ["skipped", "campanha cancelada", 2],
    ]);
    await expect(runWithTeam(TEAM, () => resumeCampaign(c.id), ADMIN)).rejects.toBeInstanceOf(CampaignEstadoInvalido);
  });
});

describe("editar a campanha pausada", () => {
  it("muda mensagem e ritmo com ela pausada, recusa a lista, e o que foi salvo vale ao retomar", async () => {
    const c = await campanhaPronta({}, 2);
    await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN);
    await runWithTeam(TEAM, () => pauseCampaign(c.id, "pausada pela equipe"), ADMIN);

    await runWithTeam(TEAM, () => saveStep(c.id, 2, { mensagem: "Texto novo, {primeiro_nome|tudo bem}?" }), ADMIN);
    await runWithTeam(
      TEAM,
      () =>
        saveStep(c.id, 3, {
          channelAccountId: contaId,
          janelaInicio: "09:00",
          janelaFim: "16:00",
          intervaloMinS: 120,
          intervaloMaxS: 240,
          loteTamanho: 10,
          pausaLoteMinM: 10,
          pausaLoteMaxM: 20,
          freioSaidasPct: 3,
          freioFalhasSeq: 5,
          limiteDiario: 50,
        }),
      ADMIN,
    );
    // A lista e a regra só mudam no rascunho.
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: "skip" }), ADMIN)).rejects.toMatchObject({ name: "CampaignNaoEditavel" });

    const r = await runWithTeam(TEAM, () => resumeCampaign(c.id), ADMIN);
    expect(r).toMatchObject({ status: "sending", mensagem: "Texto novo, {primeiro_nome|tudo bem}?", intervaloMinS: 120, limiteDiario: 50, janelaInicio: "09:00" });
  });
});

describe("previsão de término", () => {
  it("o menor entre o ritmo, o limite da campanha e o aquecimento da conta", async () => {
    // Ritmo padrão: 420 min de janela; 120 s de intervalo médio + 60 s de pausa de
    // lote por envio (20 min / 20) → 140 por dia.
    const c = await campanhaPronta({}, 0);
    const k = await Promise.all(Array.from({ length: 100 }, (_, i) => contato(`+55659992${String(i).padStart(5, "0")}`)));
    await basePrisma.campaignRecipient.createMany({
      data: k.map((x) => ({ teamId: TEAM, campaignId: c.id, contactId: x.id, status: "queued" as const })),
    });
    // Conta nova: aquecimento de 20/dia manda.
    expect(await runWithTeam(TEAM, () => estimate(c.id))).toMatchObject({ naFila: 100, porDia: 20, dias: 5 });
    // Conta madura (teto manual alto): o ritmo manda.
    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { dailyLimit: 400 } });
    expect(await runWithTeam(TEAM, () => estimate(c.id))).toMatchObject({ porDia: 140, dias: 1 });
    // Limite diário da campanha.
    await basePrisma.campaign.update({ where: { id: c.id }, data: { limiteDiario: 30 } });
    expect(await runWithTeam(TEAM, () => estimate(c.id))).toMatchObject({ porDia: 30, dias: 4 });
  });

  it("limite por dia da campanha acima do aquecimento: vale o da campanha", async () => {
    // Conta nova (aquecimento 20/dia), campanha pede 50.
    const c = await campanhaPronta({ limiteDiario: 50 }, 100);
    expect(await runWithTeam(TEAM, () => estimate(c.id))).toMatchObject({ porDia: 50, dias: 2, tetoDaConta: 20 });
  });

  it("com data de início futura, o término conta a partir dela", async () => {
    const c = await campanhaPronta({}, 0);
    const k = await contato("+5565999300001");
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "queued" } });
    const iniciaEm = new Date(Date.now() + 30 * 86_400_000);
    await basePrisma.campaign.update({ where: { id: c.id }, data: { iniciaEm } });
    const p = await runWithTeam(TEAM, () => estimate(c.id));
    expect(p.terminoPrevisto!.getTime()).toBeGreaterThan(iniciaEm.getTime());
  });
});

describe("recibo ✓✓ e resposta", () => {
  async function enviada(pid: string) {
    const c = await campanhaPronta({}, 0);
    const k = await contato(`+5565999300${pid.slice(-3)}`);
    const r = await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "sent", sentAt: new Date(), providerMessageId: pid },
    });
    return { c, k, r };
  }

  it("recibo só avança (enviada → entregue → lida), nunca volta", async () => {
    const { r } = await enviada(`PID-${sufixo}-001`);
    await runWithTeam(TEAM, () => aplicarReciboDeCampanha(r.providerMessageId!, "read"), ADMIN);
    await runWithTeam(TEAM, () => aplicarReciboDeCampanha(r.providerMessageId!, "delivered"), ADMIN);
    expect((await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("read");
  });

  it("recibo pelo webhook (applyStatusUpdate) chega no destinatário", async () => {
    const { k, r } = await enviada(`PID-${sufixo}-002`);
    const conv = await basePrisma.conversation.create({ data: { teamId: TEAM, contactId: k.id, channelAccountId: contaId, canal: "whatsapp" } });
    await basePrisma.message.create({
      data: { teamId: TEAM, conversationId: conv.id, direcao: "out", tipo: "text", conteudo: "oi", status: "sent", providerMessageId: r.providerMessageId },
    });
    // O recibo vem da instância da conta da conversa (S-14: sem isso, é ignorado).
    await applyStatusUpdate({ providerMessageId: r.providerMessageId!, status: "delivered", errorCode: null, instance: `ctl-${sufixo}` });
    expect((await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("delivered");
  });

  it("resposta: marca 'respondeu' e inscreve no fluxo Pós-resposta UMA vez, mesmo com duas mensagens", async () => {
    const { c, k, r } = await enviada(`PID-${sufixo}-003`);
    const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "Pós-resposta", triggerType: "manual", status: "active" } });
    await basePrisma.flowNode.create({ data: { id: `pr-${flow.id}`, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never } });
    await basePrisma.campaign.update({ where: { id: c.id }, data: { flowId: flow.id } });

    const [a, b] = await Promise.all([
      runWithTeam(TEAM, () => registrarRespostaDeCampanha(k.id, { messageId: "m1", texto: "oi" }), ADMIN),
      runWithTeam(TEAM, () => registrarRespostaDeCampanha(k.id, { messageId: "m2", texto: "quero saber" }), ADMIN),
    ]);
    expect([a, b].filter(Boolean)).toEqual([{ recipientId: r.id, campaignId: c.id }]);
    const depois = await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } });
    expect(depois.status).toBe("replied");
    expect(depois.repliedAt).not.toBeNull();
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: k.id, flowId: flow.id } })).toBe(1);
    // Classificação pela IA (A.5) agendada UMA vez, para a mensagem que marcou.
    expect(classificar).toHaveBeenCalledTimes(1);
    expect(classificar).toHaveBeenCalledWith({ recipientId: r.id, messageId: expect.stringMatching(/^m[12]$/) });
  });

  it("resposta pelo inbound (receiveInbound) marca o destinatário; quem não recebeu campanha não muda nada", async () => {
    const { k, r } = await enviada(`PID-${sufixo}-004`);
    const numero = (await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: k.id } })).valor;
    await receiveInbound({
      from: numero,
      fromMe: false,
      text: "tenho interesse",
      media: null,
      providerMessageId: `IN-${sufixo}-004`,
      timestamp: null,
      name: "Lead",
      instance: `ctl-${sufixo}`,
    });
    expect((await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("replied");
    const outro = await contato("+5565999300999");
    expect(await runWithTeam(TEAM, () => registrarRespostaDeCampanha(outro.id, { messageId: "x", texto: "oi" }), ADMIN)).toBeNull();
  });
});

describe("dois times", () => {
  it("o time B não inicia, pausa, retoma, cancela nem estima a campanha do A — e ela fica igual", async () => {
    const c = await campanhaPronta();
    await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN);
    const antes = await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    const destAntes = await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" } });
    ticks.mockClear();
    const noB = (fn: () => Promise<unknown>) => runWithTeam(OUTRO, fn, ADMIN);
    for (const acao of [
      () => startCampaign(c.id),
      () => pauseCampaign(c.id, "invasão"),
      () => resumeCampaign(c.id),
      () => cancelCampaign(c.id),
      () => estimate(c.id),
    ] as Array<() => Promise<unknown>>) {
      await expect(noB(acao)).rejects.toMatchObject({ name: "CampaignNotFound" });
    }
    const depois = await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect({ status: depois.status, tickToken: depois.tickToken }).toEqual({ status: antes.status, tickToken: antes.tickToken });
    expect(await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" } })).toEqual(destAntes);
    expect(ticks).not.toHaveBeenCalled();
  });

  it("recibo e resposta no contexto do B não mexem no destinatário do A", async () => {
    const c = await campanhaPronta({}, 0);
    const k = await contato("+5565999400001");
    const r = await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "sent", sentAt: new Date(), providerMessageId: `PID-${sufixo}-B1` },
    });
    const doB = await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Lead B" } });
    await runWithTeam(OUTRO, () => aplicarReciboDeCampanha(r.providerMessageId!, "read"), ADMIN);
    await runWithTeam(OUTRO, () => aplicarReciboDeCampanha(r.providerMessageId!, "failed"), ADMIN);
    expect(await runWithTeam(OUTRO, () => registrarRespostaDeCampanha(doB.id, { messageId: "b", texto: "oi" }), ADMIN)).toBeNull();
    // Nem com o contato do A (id vazado) no contexto do B.
    expect(await runWithTeam(OUTRO, () => registrarRespostaDeCampanha(k.id, { messageId: "b", texto: "oi" }), ADMIN)).toBeNull();
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "sent", repliedAt: null });
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).falhasSeguidas).toBe(0);
  });
});

describe("robustez", () => {
  it("recibo de ERRO do WhatsApp: destinatário vira falha e conta no freio de falhas seguidas", async () => {
    const c = await campanhaPronta({}, 0);
    const k = await contato("+5565999400002");
    const r = await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "delivered", sentAt: new Date(), providerMessageId: `PID-${sufixo}-F1` },
    });
    await runWithTeam(TEAM, () => aplicarReciboDeCampanha(r.providerMessageId!, "failed"), ADMIN);
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
      status: "failed",
      motivo: "o WhatsApp recusou a mensagem (recibo de erro)",
    });
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).falhasSeguidas).toBe(1);
    // Reentrega do mesmo recibo não conta de novo.
    await runWithTeam(TEAM, () => aplicarReciboDeCampanha(r.providerMessageId!, "failed"), ADMIN);
    expect((await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).falhasSeguidas).toBe(1);
  });

  it("fila fora no iniciar/retomar: a campanha não fica 'enviando' sem tick", async () => {
    const c = await campanhaPronta();
    ticks.mockRejectedValueOnce(new Error("Redis fora"));
    await expect(runWithTeam(TEAM, () => startCampaign(c.id), ADMIN)).rejects.toThrow("Redis fora");
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "draft", tickToken: null });

    await runWithTeam(TEAM, () => startCampaign(c.id), ADMIN);
    await runWithTeam(TEAM, () => pauseCampaign(c.id, "pausa"), ADMIN);
    ticks.mockRejectedValueOnce(new Error("Redis fora"));
    await expect(runWithTeam(TEAM, () => resumeCampaign(c.id), ADMIN)).rejects.toThrow("Redis fora");
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: "paused",
      tickToken: null,
      pausadoMotivo: "fila indisponível, tente de novo",
    });
  });

  it("recibo e resposta exigem papel (§12h): contexto sem identidade não escreve", async () => {
    const c = await campanhaPronta({}, 0);
    const k = await contato("+5565999400003");
    const r = await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: "sent", sentAt: new Date(), providerMessageId: `PID-${sufixo}-R1` },
    });
    const { runWithTeam: semPapel } = await import("@crmagro/db");
    await semPapel(TEAM, () => aplicarReciboDeCampanha(r.providerMessageId!, "read"));
    expect(await semPapel(TEAM, () => registrarRespostaDeCampanha(k.id, { messageId: "x", texto: "oi" }))).toBeNull();
    expect((await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("sent");
  });
});
