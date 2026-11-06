import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Classificação da resposta de campanha (produto §A.5, 2ª metade). IA e fila
 * MOCKADAS: nada sai para provedor de IA nem para o WhatsApp.
 */
const chamarIa = vi.fn();
const provedoresConectados = vi.fn(async () => [{ provider: "anthropic", apiKey: "x", model: "m" }]);
vi.mock("../ai/provedores", async (orig) => ({
  ...(await orig<typeof import("../ai/provedores")>()),
  chamarIa: (...a: unknown[]) => chamarIa(...a),
  provedoresConectados: (...a: unknown[]) => provedoresConectados(...(a as [])),
}));
const enfileirarJobDeIa = vi.fn(async () => {});
vi.mock("../ai/queue", async (orig) => ({
  ...(await orig<typeof import("../ai/queue")>()),
  enfileirarJobDeIa: (...a: unknown[]) => enfileirarJobDeIa(...(a as [])),
}));
vi.mock("../flows/queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { processarClassificacao, agendarClassificacaoDaResposta, listarSugestoesDeSaida, corrigirClassificacao, DestinatarioNaoEncontrado } =
  await import("./classificacao");
const { marcarOptOut } = await import("../conversations/opt-out");
const { IaChamadaFalhou } = await import("../ai/provedores");
const { ForbiddenError } = await import("../auth/authz");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM = "00000000-0000-0000-0000-0000000002b0";
const OUTRO = "00000000-0000-0000-0000-0000000002b1";
const AGORA = new Date("2026-09-28T13:00:00.000Z"); // 10:00 em São Paulo
const DIA_SP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/** A IA "responde" este texto. */
function iaResponde(texto: string) {
  chamarIa.mockResolvedValueOnce({ data: { content: [{ type: "text", text: texto }] }, usado: 0 });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Classificação (test)"], [OUTRO, "Team Classificação B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  chamarIa.mockReset();
  provedoresConectados.mockClear();
  enfileirarJobDeIa.mockClear();
  delete process.env.AI_CLASSIFICACAO_POR_DIA;
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.appointment.deleteMany({ where: w });
    await basePrisma.campaignRecipient.deleteMany({ where: w });
    await basePrisma.campaign.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.flowNode.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.message.deleteMany({ where: w });
    await basePrisma.conversation.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
    await basePrisma.channelAccount.deleteMany({ where: w });
    await basePrisma.teamConfig.deleteMany({ where: w });
    await redisEstado().del(`ai:classificacao:${teamId}:${DIA_SP.format(AGORA)}`);
  }
});

async function ligarIa(teamId: string, modo: "off" | "read_only" | "read_write" = "read_only") {
  await basePrisma.teamConfig.upsert({ where: { teamId }, update: { aiMode: modo }, create: { teamId, aiMode: modo } });
}

/** Destinatário que recebeu a campanha e respondeu `resposta`. */
async function respondeu(teamId: string, resposta: string, extra: { interesse?: "nao_avaliado" | "sem_interesse" } = {}) {
  const conta = await basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `cls-${Math.random().toString(36).slice(2, 10)}`, status: "connected" },
  });
  const contato = await basePrisma.contact.create({ data: { teamId, nome: "Produtor", interesse: extra.interesse ?? "nao_avaliado" } });
  const conv = await basePrisma.conversation.create({ data: { teamId, contactId: contato.id, channelAccountId: conta.id, canal: "whatsapp" } as never });
  const enviada = await basePrisma.message.create({
    data: { teamId, conversationId: conv.id, direcao: "out", tipo: "text", conteudo: "Bom dia! Temos semente de soja para a safra 26. Posso te mandar a tabela?" } as never,
  });
  const recebida = await basePrisma.message.create({ data: { teamId, conversationId: conv.id, direcao: "in", tipo: "text", conteudo: resposta } as never });
  const campanha = await basePrisma.campaign.create({ data: { teamId, nome: "Safra 26", status: "sending", mensagem: "Bom dia!" } });
  const dest = await basePrisma.campaignRecipient.create({
    data: { teamId, campaignId: campanha.id, contactId: contato.id, status: "replied", messageId: enviada.id, sentAt: new Date(AGORA.getTime() - 86_400_000), repliedAt: AGORA },
  });
  const job = { kind: "classificar-resposta" as const, teamId, recipientId: dest.id, messageId: recebida.id };
  return { contato, dest, job };
}

const processar = (job: { teamId: string } & Parameters<typeof processarClassificacao>[0]) =>
  runWithTeam(job.teamId, () => processarClassificacao(job, { agora: AGORA }), { userId: "system", role: "owner" });
const destinatario = (id: string) => basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id } });

describe("classificação pela IA", () => {
  it("interessada → classificação e interesse do contato; a resposta vai delimitada como não confiável", async () => {
    await ligarIa(TEAM);
    const { contato, dest, job } = await respondeu(TEAM, "Pode mandar sim, quanto está o saco?");
    iaResponde('```json\n{"classe": "interessada", "quandoVoltar": null}\n```');

    expect(await processar(job)).toEqual({ status: "classificado", classe: "interessada", via: "ia" });
    expect((await destinatario(dest.id)).classificacao).toBe("interessada");
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: contato.id } })).interesse).toBe("interessado");

    const corpo = chamarIa.mock.calls[0]![1] as { messages: Array<{ content: string }>; temperature: number };
    expect(corpo.temperature).toBe(0);
    expect(corpo.messages[0]!.content).toContain("<historico_nao_confiavel>\nPode mandar sim, quanto está o saco?\n</historico_nao_confiavel>");
    expect(corpo.messages[0]!.content).toContain("HOJE: 2026-09-28");
    expect(corpo.messages[0]!.content).toContain("Temos semente de soja");
  });

  it("interessada não desfaz a qualificação de um humano", async () => {
    await ligarIa(TEAM);
    const { contato, job } = await respondeu(TEAM, "manda", { interesse: "sem_interesse" });
    iaResponde('{"classe":"interessada","quandoVoltar":null}');
    await processar(job);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: contato.id } })).interesse).toBe("sem_interesse");
  });

  it("pediu_depois com data → follow_up na Agenda às 09:00; data impossível → sem compromisso", async () => {
    await ligarIa(TEAM);
    const a = await respondeu(TEAM, "Agora não, me chama dia 15 de outubro");
    iaResponde('{"classe":"pediu_depois","quandoVoltar":"2026-10-15"}');
    await processar(a.job);
    const ag = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, contactId: a.contato.id } });
    expect(ag).toMatchObject({ tipo: "follow_up", titulo: "Retomar contato (pediu para depois)" });
    expect(ag.inicio.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(ag.descricao).toContain("Safra 26");

    const b = await respondeu(TEAM, "depois a gente fala");
    iaResponde('{"classe":"pediu_depois","quandoVoltar":"2020-01-01"}');
    await processar(b.job);
    expect((await destinatario(b.dest.id)).classificacao).toBe("pediu_depois");
    expect(await basePrisma.appointment.count({ where: { contactId: b.contato.id } })).toBe(0);
  });

  it("saiu → só SUGESTÃO: nota e lista de sugestões; o opt-out vem da confirmação humana", async () => {
    await ligarIa(TEAM);
    const { contato, dest, job } = await respondeu(TEAM, "Não quero");
    iaResponde('{"classe":"saiu","quandoVoltar":null}');
    await processar(job);

    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contato.id } });
    expect(c.relacionamentoStatus).not.toBe("opt_out");
    expect(c.tags ?? []).not.toContain("Pediu para sair");
    expect((await destinatario(dest.id)).status).toBe("replied");
    const nota = await basePrisma.activity.findFirstOrThrow({ where: { contactId: contato.id, tipo: "note" } });
    expect(nota.conteudo).toContain("IA sugere: pediu para sair");
    expect(nota.meta).toMatchObject({ sugestaoOptOut: true, recipientId: dest.id });

    expect((await runWithTeam(TEAM, () => listarSugestoesDeSaida())).map((s) => s.recipientId)).toEqual([dest.id]);
    // Humano confirma → opt-out de verdade (#112) e a sugestão sai da lista.
    // O envio do destinatário é de AGORA - 1 dia; o opt-out olha os últimos 30 dias pelo relógio. Sem fixar a data, o teste
    // quebra assim que o relógio real passa de AGORA + 29 dias. Só `Date` é falseado: timers e fila seguem reais.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AGORA);
    try {
      await runWithTeam(TEAM, () => marcarOptOut(contato.id));
    } finally {
      vi.useRealTimers();
    }
    expect((await destinatario(dest.id)).status).toBe("opted_out");
    expect(await runWithTeam(TEAM, () => listarSugestoesDeSaida())).toEqual([]);
  });

  it("saída fora do formato → outro; erro não transitório → outro; transitório → relança (retry do job)", async () => {
    await ligarIa(TEAM);
    const a = await respondeu(TEAM, "kkk");
    iaResponde("Acho que é interesse, talvez.");
    expect(await processar(a.job)).toMatchObject({ classe: "outro", via: "ia" });

    const b = await respondeu(TEAM, "ok");
    chamarIa.mockRejectedValueOnce(new IaChamadaFalhou("HTTP 400", false));
    expect(await processar(b.job)).toMatchObject({ classe: "outro" });

    const c = await respondeu(TEAM, "quanto custa?");
    chamarIa.mockRejectedValueOnce(new IaChamadaFalhou("IA indisponível", true));
    await expect(processar(c.job)).rejects.toBeInstanceOf(IaChamadaFalhou);
    expect((await destinatario(c.dest.id)).classificacao).toBeNull();
  });

  it("IA fora nas 3 tentativas: as 2 primeiras relançam (retry), a última grava outro; a cota não é gasta", async () => {
    await ligarIa(TEAM);
    const { dest, job } = await respondeu(TEAM, "quanto custa?");
    await redisEstado().del(`ai:classificacao:falhas:${dest.id}`);
    chamarIa.mockRejectedValue(new IaChamadaFalhou("IA indisponível", true));
    await expect(processar(job)).rejects.toBeInstanceOf(IaChamadaFalhou);
    await expect(processar(job)).rejects.toBeInstanceOf(IaChamadaFalhou);
    expect(await processar(job)).toEqual({ status: "classificado", classe: "outro", via: "sem_ia" });
    expect((await destinatario(dest.id)).classificacao).toBe("outro");
    // As 3 chamadas sem resposta foram devolvidas à cota do dia.
    expect(Number((await redisEstado().get(`ai:classificacao:${TEAM}:${DIA_SP.format(AGORA)}`)) ?? 0)).toBe(0);
    await redisEstado().del(`ai:classificacao:falhas:${dest.id}`);
  });

  it("RBAC: processar sem papel de escrita (viewer) é recusado", async () => {
    await ligarIa(TEAM);
    const { dest, job } = await respondeu(TEAM, "manda");
    await expect(
      runWithTeam(TEAM, () => processarClassificacao(job, { agora: AGORA }), { userId: "v", role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(chamarIa).not.toHaveBeenCalled();
    expect((await destinatario(dest.id)).classificacao).toBeNull();
  });
});

describe("governança, idempotência e cota", () => {
  it("aiMode off (padrão) → outro, sem chamar a IA", async () => {
    const { dest, job } = await respondeu(TEAM, "quanto custa?");
    expect(await processar(job)).toEqual({ status: "classificado", classe: "outro", via: "sem_ia" });
    expect(chamarIa).not.toHaveBeenCalled();
    expect((await destinatario(dest.id)).classificacao).toBe("outro");
  });

  it("destinatário que a regra do inbound já marcou opted_out → saiu, sem IA", async () => {
    await ligarIa(TEAM);
    const { dest, job } = await respondeu(TEAM, "Pare");
    await basePrisma.campaignRecipient.update({ where: { id: dest.id }, data: { status: "opted_out" } });
    expect(await processar(job)).toEqual({ status: "classificado", classe: "saiu", via: "regra" });
    expect(chamarIa).not.toHaveBeenCalled();
  });

  it("job repetido não chama a IA de novo nem duplica o compromisso", async () => {
    await ligarIa(TEAM);
    const { contato, job } = await respondeu(TEAM, "me chama dia 15/10");
    iaResponde('{"classe":"pediu_depois","quandoVoltar":"2026-10-15"}');
    await processar(job);
    expect(await processar(job)).toEqual({ status: "ja_classificado" });
    expect(chamarIa).toHaveBeenCalledTimes(1);
    expect(await basePrisma.appointment.count({ where: { contactId: contato.id } })).toBe(1);
  });

  it("cota do dia esgotada → outro, sem IA", async () => {
    await ligarIa(TEAM);
    process.env.AI_CLASSIFICACAO_POR_DIA = "1";
    const a = await respondeu(TEAM, "manda");
    const b = await respondeu(TEAM, "manda também");
    iaResponde('{"classe":"interessada","quandoVoltar":null}');
    await processar(a.job);
    expect(await processar(b.job)).toEqual({ status: "classificado", classe: "outro", via: "cota" });
    expect(chamarIa).toHaveBeenCalledTimes(1);
  });
});

describe("dois times e tela", () => {
  it("job com o time B não enxerga o destinatário do A; sugestões não vazam", async () => {
    await ligarIa(TEAM);
    await ligarIa(OUTRO);
    const a = await respondeu(TEAM, "sai daqui");
    iaResponde('{"classe":"saiu","quandoVoltar":null}');
    await processar(a.job);

    expect(await processar({ ...a.job, teamId: OUTRO })).toEqual({ status: "sem_destinatario" });
    expect(await runWithTeam(OUTRO, () => listarSugestoesDeSaida())).toEqual([]);
    await expect(runWithTeam(OUTRO, () => corrigirClassificacao(a.dest.id, "outro"))).rejects.toBeInstanceOf(DestinatarioNaoEncontrado);
    expect((await destinatario(a.dest.id)).classificacao).toBe("saiu");
  });

  it("corrigir classificação: viewer não pode; member corrige e a sugestão sai da lista", async () => {
    await ligarIa(TEAM);
    const { dest, job } = await respondeu(TEAM, "não quero mais");
    iaResponde('{"classe":"saiu","quandoVoltar":null}');
    await processar(job);
    await expect(runWithTeam(TEAM, () => corrigirClassificacao(dest.id, "outro"), { userId: "v", role: "viewer" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await runWithTeam(TEAM, () => corrigirClassificacao(dest.id, "duvida"), { userId: "m", role: "member" });
    expect((await destinatario(dest.id)).classificacao).toBe("duvida");
    expect(await runWithTeam(TEAM, () => listarSugestoesDeSaida())).toEqual([]);
  });

  it("agendar: um job por destinatário+mensagem, no time do contexto, jobId sem ':'", async () => {
    await runWithTeam(TEAM, () => agendarClassificacaoDaResposta({ recipientId: "r1", messageId: "m1" }));
    expect(enfileirarJobDeIa).toHaveBeenCalledWith(
      { kind: "classificar-resposta", teamId: TEAM, recipientId: "r1", messageId: "m1" },
      { jobId: "classificar_r1_m1", tentativas: 3 },
    );
  });

  it("agendar com o Redis travado não segura quem chamou (desiste em 3 s, sem lançar)", async () => {
    enfileirarJobDeIa.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = Date.now();
    await expect(runWithTeam(TEAM, () => agendarClassificacaoDaResposta({ recipientId: "r2", messageId: "m2" }))).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_900);
    expect(Date.now() - t0).toBeLessThan(6_000);
  });
});
