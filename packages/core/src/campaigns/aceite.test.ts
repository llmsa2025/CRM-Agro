import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { ChannelSendFailed } from "@crmagro/channels";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";
import { zonedTimeToUtc } from "../motor-do-dia/tz";

/**
 * ACEITE das Campanhas (produto §A.7), ponta a ponta no core: rascunho → lista
 * → iniciar → ticks até concluir, com o relógio controlado. No meio: pedido de
 * saída, resposta com fluxo, pausar/retomar, "restart" com envio incerto,
 * freio de falhas e cancelar. O canal (Evolution) é FALSO — nada sai.
 * Invariante que o teste cobra do começo ao fim: NENHUM número recebe duas vezes.
 */
const enviados: Array<{ to: string; text?: string }> = [];
const canal = vi.hoisted(() => ({ falha: null as null | (() => never) }));
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: () => ({
    send: async (input: { to: string; content: { text?: string } }) => {
      if (canal.falha) canal.falha();
      enviados.push({ to: input.to, text: input.content.text });
      return { providerMessageId: `ACEITE-${enviados.length}-${Math.random().toString(36).slice(2, 8)}` };
    },
  }),
}));
// Fila da campanha: os jobs ficam aqui e o teste os "processa" em ordem.
const fila = vi.hoisted(() => ({ ticks: [] as Array<{ job: Record<string, unknown>; delayMs: number }> }));
vi.mock("./queue", () => ({
  agendarTick: async (x: Record<string, unknown> & { delayMs: number }) => {
    const { delayMs, ...job } = x;
    fila.ticks.push({ job: { kind: "tick", ...job }, delayMs });
  },
  agendarMontagemDaLista: async () => {},
  getCampaignQueue: () => ({}),
}));
const semWhats = vi.hoisted(() => new Set<string>());
vi.mock("./tem-whatsapp", () => ({
  temWhatsApp: async (numeros: string[]) =>
    new Map(numeros.map((n) => [n, { existe: semWhats.has(n) ? false : null, nome: null }])),
}));
vi.mock("./classificacao", () => ({ agendarClassificacaoDaResposta: async () => {} }));
vi.mock("../flows/queue", () => ({ scheduleStep: vi.fn(), acordarPasso: vi.fn(), getFlowQueue: () => ({}) }));

const { createCampaign, saveStep, prepararLista, montarLista } = await import("./service");
const { startCampaign, pauseCampaign, resumeCampaign, cancelCampaign } = await import("./controle");
const { processarTickDaCampanha } = await import("./tick");
const { receiveInbound } = await import("../conversations/service");

const TEAM = "00000000-0000-0000-0000-0000000003b1";
const ADMIN = { userId: "admin", role: "admin" };
const MEMBRO = { userId: "membro", role: "member" };
const SISTEMA = { userId: "sistema", role: "owner" };
const TZ = "America/Sao_Paulo";
const SEGUNDA_9H = zonedTimeToUtc(2026, 9, 28, 9, 0, TZ);
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `aceite-${sufixo}`;
let contaId = "";
let relogio = SEGUNDA_9H;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Campanhas aceite (test)" } });
});

beforeEach(async () => {
  enviados.length = 0;
  fila.ticks.length = 0;
  canal.falha = null;
  semWhats.clear();
  relogio = SEGUNDA_9H;
  const w = { teamId: TEAM };
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
  await redisEstado().del(`flow:balde:${TEAM}`);
  const conta = await basePrisma.channelAccount.create({
    data: {
      ownerId: MEMBRO.userId, // F3: a conta é de quem opera a campanha
      teamId: TEAM,
      canal: "whatsapp",
      label: "WA",
      provider: "evolution",
      externalId: INSTANCIA,
      status: "connected",
      credentials: { instance: INSTANCIA },
      dailyLimit: 400,
    },
  });
  contaId = conta.id;
});

const NUMEROS = ["+5565988100001", "+5565988100002", "+5565988100003", "+5565988100004", "+5565988100005"];
const SEM_WHATS = "+5565988100009";

/** Rascunho completo + lista montada (5 na fila, 1 sem WhatsApp fora). */
async function campanhaMontada(extra: Record<string, unknown> = {}) {
  const c = await runWithTeam(TEAM, () => createCampaign("Safra — aceite"), MEMBRO);
  await runWithTeam(TEAM, () => saveStep(c.id, 2, { mensagem: "{saudacao}, {primeiro_nome|tudo bem}? Posso te mostrar a nova linha?" }), MEMBRO);
  await runWithTeam(
    TEAM,
    () =>
      saveStep(c.id, 3, {
        channelAccountId: contaId,
        janelaInicio: "08:30",
        janelaFim: "17:30",
        pausaAlmocoInicio: "11:30",
        pausaAlmocoFim: "13:30",
        intervaloMinS: 60,
        intervaloMaxS: 180,
        loteTamanho: 20,
        pausaLoteMinM: 15,
        pausaLoteMaxM: 25,
        freioSaidasPct: 50,
        freioFalhasSeq: 5,
        ...extra,
      }),
    MEMBRO,
  );
  semWhats.add(SEM_WHATS);
  const texto = [...NUMEROS.map((n, i) => `Lead ${i + 1}; ${n}`), `Sem Zap; ${SEM_WHATS}`].join("\n");
  const { versao } = await runWithTeam(TEAM, () => prepararLista(c.id, { tipo: "colados", texto }), MEMBRO);
  const resumo = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico: async () => false }), SISTEMA);
  expect(resumo).toMatchObject({ fila: 5, semWhatsApp: 1, contatosNovos: 5 });
  return c;
}

/** Processa o próximo tick agendado, andando o relógio pelo atraso dele. */
async function proximoTick(): Promise<string | null> {
  const t = fila.ticks.shift();
  if (!t) return null;
  relogio = new Date(relogio.getTime() + t.delayMs);
  return runWithTeam(TEAM, () => processarTickDaCampanha(t.job as never, { agora: relogio, aleatorio: () => 0 }), SISTEMA);
}

const destinatarios = async (campaignId: string) =>
  Object.fromEntries(
    (await basePrisma.campaignRecipient.findMany({ where: { campaignId }, select: { telefone: true, status: true, motivo: true } })).map(
      (d) => [d.telefone!, `${d.status}${d.motivo ? ` (${d.motivo})` : ""}`],
    ),
  );

function ninguemRecebeuDuasVezes() {
  const porNumero = new Map<string, number>();
  for (const e of enviados) porNumero.set(e.to, (porNumero.get(e.to) ?? 0) + 1);
  expect([...porNumero.values()].every((n) => n === 1)).toBe(true);
}

const receber = (numero: string, texto: string) =>
  receiveInbound({
    from: numero,
    fromMe: false,
    text: texto,
    media: null,
    providerMessageId: `IN-${sufixo}-${numero.slice(-4)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: null,
    name: "Lead",
    instance: INSTANCIA,
  });

// Teto de 30 s (o padrão é 5 s): são cenários de ponta a ponta com dezenas de consultas em série. Contra um banco
// REMOTO (o TESTE do Supabase) já levavam 3 a 4 s como dono e passam de 5 s pelo papel crmagro_app, que gasta
// 4 idas ao banco por consulta avulsa em vez de 1. Não é defeito de RLS.
describe("aceite: campanha do início ao fim", { timeout: 30_000 }, () => {
  it("opt-out no meio, resposta com fluxo, pausar/retomar e restart com envio incerto — ninguém recebe duas vezes", async () => {
    const c = await campanhaMontada();
    const posResposta = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "Pós-resposta", triggerType: "manual", status: "active" } });
    await basePrisma.flowNode.create({ data: { id: `pr-${posResposta.id}`, teamId: TEAM, flowId: posResposta.id, tipo: "wait" as never, config: {} as never } });
    await basePrisma.campaign.update({ where: { id: c.id }, data: { flowId: posResposta.id } });

    await runWithTeam(TEAM, () => startCampaign(c.id, relogio), ADMIN);
    expect(await proximoTick()).toBe("enviado"); // Lead 1
    expect(enviados.map((e) => e.to)).toEqual([NUMEROS[0]]);
    expect(enviados[0]!.text).toBe("Bom dia, Lead? Posso te mostrar a nova linha?");

    // O Lead 2 (ainda na fila) manda "pare" antes da vez dele: sai da campanha.
    await receber(NUMEROS[1]!, "PARE");
    // O Lead 1 responde normalmente: "respondeu" + fluxo Pós-resposta.
    await receber(NUMEROS[0]!, "Oi, pode mandar");

    expect(await proximoTick()).toBe("enviado"); // Lead 3 (o 2 foi pulado pelo opt-out)
    expect(enviados.map((e) => e.to)).toEqual([NUMEROS[0], NUMEROS[2]]);

    // Pausar (membro): o tick que já estava agendado morre sem enviar.
    await runWithTeam(TEAM, () => pauseCampaign(c.id, "pausa para almoço da equipe"), MEMBRO);
    expect(await proximoTick()).toBe("corrente_morta");
    expect(fila.ticks).toHaveLength(0);
    // Retomar (admin): corrente nova, segue do ponto.
    await runWithTeam(TEAM, () => resumeCampaign(c.id, relogio), ADMIN);
    expect(await proximoTick()).toBe("enviado"); // Lead 4

    // "Restart": o processo caiu no meio do envio do Lead 5 (marca de envio
    // gravada, sem confirmação) há mais de 10 min. O tick seguinte SEGURA — não reenvia.
    const velho = new Date(relogio.getTime() - 11 * 60_000);
    await basePrisma.campaignRecipient.updateMany({
      where: { campaignId: c.id, telefone: NUMEROS[4] },
      data: { status: "sending", reservadoEm: velho, enviandoEm: velho },
    });
    let desfecho: string | null;
    do desfecho = await proximoTick();
    while (desfecho && desfecho !== "concluida");
    expect(desfecho).toBe("concluida");

    expect(enviados.map((e) => e.to)).toEqual([NUMEROS[0], NUMEROS[2], NUMEROS[3]]);
    ninguemRecebeuDuasVezes();
    expect(await destinatarios(c.id)).toEqual({
      [NUMEROS[0]!]: "replied",
      [NUMEROS[1]!]: "skipped (pediu para sair)",
      [NUMEROS[2]!]: "sent",
      [NUMEROS[3]!]: "sent",
      [NUMEROS[4]!]: "held (resultado incerto, conferir no WhatsApp)",
    });
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "done", tickToken: null });
    // Fluxo Pós-resposta: 1 inscrição (a do Lead 1).
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, flowId: posResposta.id } })).toBe(1);
    // Reentrega de um tick velho depois de concluída: nada.
    expect(
      await runWithTeam(TEAM, () => processarTickDaCampanha({ kind: "tick", teamId: TEAM, campaignId: c.id, token: "velho", seq: 99 }, { agora: relogio }), SISTEMA),
    ).toBe("corrente_morta");
    expect(enviados).toHaveLength(3);
  });

  it("freio: 5 falhas seguidas pausam; retomar com o número de volta termina sem duplicar", async () => {
    const c = await campanhaMontada();
    await runWithTeam(TEAM, () => startCampaign(c.id, relogio), ADMIN);
    canal.falha = () => {
      throw new ChannelSendFailed("Evolution 503", "not_sent", true);
    };
    const desfechos: string[] = [];
    for (let i = 0; i < 6; i++) desfechos.push((await proximoTick())!);
    // 5 tentativas "não saiu" (cada destinatário volta para a fila em 5 min), e o freio.
    expect(desfechos).toEqual(["adiado", "adiado", "adiado", "adiado", "adiado", "freio"]);
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: "paused",
      pausadoMotivo: "5 falhas seguidas",
    });
    expect(enviados).toEqual([]);
    expect(fila.ticks).toHaveLength(0);

    canal.falha = null;
    relogio = new Date(relogio.getTime() + 10 * 60_000); // o backoff de 5 min passou
    await runWithTeam(TEAM, () => resumeCampaign(c.id, relogio), ADMIN);
    let desfecho: string | null;
    do desfecho = await proximoTick();
    while (desfecho && desfecho !== "concluida");
    expect(desfecho).toBe("concluida");
    expect(enviados).toHaveLength(5);
    ninguemRecebeuDuasVezes();
    expect(Object.values(await destinatarios(c.id))).toEqual(["sent", "sent", "sent", "sent", "sent"]);
  });

  it("cancelar no meio: quem estava na fila não recebe mais", async () => {
    const c = await campanhaMontada();
    await runWithTeam(TEAM, () => startCampaign(c.id, relogio), ADMIN);
    expect(await proximoTick()).toBe("enviado");
    await runWithTeam(TEAM, () => cancelCampaign(c.id), MEMBRO);
    expect(await proximoTick()).toBe("corrente_morta");
    expect(enviados).toHaveLength(1);
    const d = Object.values(await destinatarios(c.id));
    expect(d.filter((x) => x === "sent")).toHaveLength(1);
    expect(d.filter((x) => x === "skipped (campanha cancelada)")).toHaveLength(4);
  });
});
