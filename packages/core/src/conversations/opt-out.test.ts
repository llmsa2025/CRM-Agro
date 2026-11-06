import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Opt-out automático (N12, produto §A.5): a regra (casos reais em português,
 * inclusive os que NÃO podem virar opt-out) e os efeitos pelo caminho real do
 * `receiveInbound`. Fila do motor mockada — nada é enviado.
 */
const acordarPasso = vi.fn(async () => {});
const scheduleStep = vi.fn(async () => {});
vi.mock("../flows/queue", () => ({
  acordarPasso: (...a: unknown[]) => acordarPasso(...(a as [])),
  scheduleStep: (...a: unknown[]) => scheduleStep(...(a as [])),
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const { classificarOptOut, marcarOptOut, TAG_PEDIU_PARA_SAIR } = await import("./opt-out");
const { receiveInbound } = await import("./service");
const { ForbiddenError } = await import("../auth/authz");

const TEAM = "00000000-0000-0000-0000-0000000002a0";
const OUTRO = "00000000-0000-0000-0000-0000000002af";
const sufixo = Math.random().toString(36).slice(2, 8);
const DIA = 86_400_000;
let seq = 0;

describe("regra de opt-out (casos reais)", () => {
  const SAIDA = [
    "Pare",
    "PARE!!!",
    "pare por favor",
    "Parar",
    "Para.",
    "Parem",
    "Sair",
    "sair 🙏",
    "Sair, obrigado",
    "Quero sair da lista",
    "me tira dessa lista",
    "Me remova da sua lista, obrigado",
    "Pode me remover da sua lista?",
    "Remova meu número",
    "exclui meu contato",
    "Não quero mais receber essas mensagens",
    "nao quero receber",
    "Pare de me mandar mensagem",
    "Pare de me mandar mensagem agora!",
    "Para de mandar mensagem",
    "parem de me encher",
    "Por favor, pare de enviar mensagens",
    "não me mande mais nada",
    "Não me liguem mais",
    "cancelar inscrição",
    "STOP",
    "descadastrar",
    "Chega de mensagem",
    "Pare com isso",
  ];
  const NAO_E_SAIDA = [
    // adiamento: é "pediu depois", não saída definitiva
    "Não quero agora, me chama semana que vem",
    "não quero agora",
    "Não quero no momento",
    "não quero por enquanto, obrigado",
    "Hoje não dá, me liga amanhã",
    "Pode parar de me ligar depois das 18h?",
    // negação do próprio pedido
    "não quero sair da lista",
    "Não precisa me tirar da lista, só estou ocupado",
    // outro assunto
    "Não quero perder essa oportunidade!",
    "Cancelar a visita de amanhã",
    "Cancela o pedido anterior e manda o novo orçamento",
    "Para quem é essa mensagem?",
    "Para mim serve, pode mandar",
    "Sair como?",
    "Sair para almoçar, já volto",
    "Pode remover o item 3 do orçamento",
    "tira o adubo da lista",
    "Não quero receber o boleto por email, manda no zap",
    "Não quero mais pagar caro no adubo",
    // recusa não é opt-out (vai para a classificação da IA, que só sugere)
    "Não quero",
    "Não quero, obrigado",
    "não quero mais",
    "Não quero mais nada, valeu",
    "Cancelar",
    "CANCELAR",
    "Não tenho interesse",
    "Não, obrigado",
    "Sim, quero saber mais",
    "👍",
    "",
  ];

  it.each(SAIDA)("SAÍDA: %s", (texto) => {
    expect(classificarOptOut(texto).optOut).toBe(true);
  });

  it.each(NAO_E_SAIDA)("não é saída: %s", (texto) => {
    expect(classificarOptOut(texto).optOut).toBe(false);
  });

  it("adiamento é sinalizado (insumo da classificação), sem opt-out", () => {
    expect(classificarOptOut("Não quero agora, me chama semana que vem")).toEqual({ optOut: false, adiamento: true, regra: null });
  });

  it("comando extra por ambiente", () => {
    process.env.OPT_OUT_COMANDOS_EXTRA = "Não me perturbe, sai fora";
    try {
      expect(classificarOptOut("sai fora!").optOut).toBe(true);
      expect(classificarOptOut("Não me perturbe").optOut).toBe(true);
    } finally {
      delete process.env.OPT_OUT_COMANDOS_EXTRA;
    }
  });
});

// ---------------------------------------------------------------------------
// Efeitos, pelo caminho real (receiveInbound)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Opt-out (test)"], [OUTRO, "Team Opt-out B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  acordarPasso.mockClear();
  scheduleStep.mockClear();
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
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
    await basePrisma.channelAccount.deleteMany({ where: w });
  }
});

const NUMERO = "5565955550101";

/**
 * Cenário do time: conta de WhatsApp, contato com o número, inscrição ativa e
 * uma segurada, fluxo "mensagem recebida" ativo, campanha que ele recebeu há 2
 * dias e outra em que ainda está na fila.
 */
async function cenario(teamId: string) {
  const conta = await basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `optout-${teamId.slice(-3)}-${sufixo}`, status: "connected" },
  });
  // Compartilhado (F3): o membro do teste marca opt-out em contato do time.
  const contato = await basePrisma.contact.create({ data: { teamId, nome: `Lead ${seq++}`, compartilhado: true } });
  await basePrisma.channelIdentifier.create({ data: { teamId, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true } });

  const fluxo = await basePrisma.flow.create({ data: { teamId, nome: `Cadência ${seq++}`, triggerType: "manual", status: "active" } });
  const no = `n-${fluxo.id}`;
  await basePrisma.flowNode.create({ data: { id: no, teamId, flowId: fluxo.id, tipo: "wait" as never, config: {} as never } });
  const ativa = await basePrisma.enrollment.create({
    data: { teamId, flowId: fluxo.id, contactId: contato.id, currentNodeId: no, currentRound: 1, status: "active", nextRunAt: new Date() },
  });
  const outro = await basePrisma.flow.create({ data: { teamId, nome: `Cadência ${seq++}`, triggerType: "manual", status: "active" } });
  await basePrisma.flowNode.create({ data: { id: `n-${outro.id}`, teamId, flowId: outro.id, tipo: "wait" as never, config: {} as never } });
  const segurada = await basePrisma.enrollment.create({
    data: { teamId, flowId: outro.id, contactId: contato.id, currentNodeId: `n-${outro.id}`, currentRound: 1, status: "waiting", nextRunAt: null },
  });

  const aoResponder = await basePrisma.flow.create({ data: { teamId, nome: `Resposta ${seq++}`, triggerType: "message_received", status: "active" } });
  await basePrisma.flowNode.create({ data: { id: `n-${aoResponder.id}`, teamId, flowId: aoResponder.id, tipo: "wait" as never, config: {} as never } });

  const campanha = await basePrisma.campaign.create({ data: { teamId, nome: "Safra 26", status: "sending" } });
  const recebeu = await basePrisma.campaignRecipient.create({
    data: { teamId, campaignId: campanha.id, contactId: contato.id, status: "delivered", sentAt: new Date(Date.now() - 2 * DIA) },
  });
  const proxima = await basePrisma.campaign.create({ data: { teamId, nome: "Pós-safra", status: "sending" } });
  const naFila = await basePrisma.campaignRecipient.create({
    data: { teamId, campaignId: proxima.id, contactId: contato.id, status: "queued" },
  });
  return { conta, contato, ativa, segurada, aoResponder, recebeu, naFila };
}

let msgSeq = 0;
function receber(instance: string, text: string, providerMessageId = `OPT-${sufixo}-${msgSeq++}`) {
  return receiveInbound({ from: NUMERO, fromMe: false, text, media: null, providerMessageId, timestamp: null, name: "Lead", instance });
}

const contatoDe = (id: string) => basePrisma.contact.findUniqueOrThrow({ where: { id } });
const notasDeSaida = (contactId: string) =>
  basePrisma.activity.count({ where: { contactId, tipo: "note", meta: { path: ["optOut"], equals: true } } });

describe("opt-out pelo receiveInbound", () => {
  it('"Pare" marca opt-out, tag, encerra inscrições, marca a campanha e NÃO reage à mensagem', async () => {
    const c = await cenario(TEAM);
    await receber(c.conta.externalId!, "Pare!");

    const contato = await contatoDe(c.contato.id);
    expect(contato.relacionamentoStatus).toBe("opt_out");
    expect(contato.tags.filter((t) => t === TAG_PEDIU_PARA_SAIR)).toHaveLength(1);
    for (const e of [c.ativa, c.segurada]) {
      expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "done", nextRunAt: null });
    }
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: c.recebeu.id } })).toMatchObject({
      status: "opted_out",
      motivo: "pediu para sair",
      classificacao: "saiu",
    });
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: c.naFila.id } })).toMatchObject({
      status: "skipped",
      motivo: "pediu para sair",
    });
    expect(await notasDeSaida(c.contato.id)).toBe(1);
    // Nada de reação: nem fluxo "mensagem recebida", nem acordar "respondeu?".
    expect(await basePrisma.enrollment.count({ where: { flowId: c.aoResponder.id } })).toBe(0);
    expect(scheduleStep).not.toHaveBeenCalled();
    expect(acordarPasso).not.toHaveBeenCalled();
    // A mensagem em si fica gravada normalmente no histórico.
    expect(await basePrisma.message.count({ where: { teamId: TEAM, conteudo: "Pare!" } })).toBe(1);
  });

  it("idempotente: mensagem reentregue e um 2º pedido não duplicam tag, nota nem efeitos", async () => {
    const c = await cenario(TEAM);
    const id = `OPT-${sufixo}-dup`;
    await receber(c.conta.externalId!, "Pare", id);
    await receber(c.conta.externalId!, "Pare", id); // reentrega (mesmo providerMessageId)
    await receber(c.conta.externalId!, "me tira dessa lista"); // 2º pedido, outra mensagem
    await runWithTeam(TEAM, () => marcarOptOut(c.contato.id)); // e o vendedor marca de novo

    const contato = await contatoDe(c.contato.id);
    expect(contato.tags.filter((t) => t === TAG_PEDIU_PARA_SAIR)).toHaveLength(1);
    expect(await notasDeSaida(c.contato.id)).toBe(1);
    expect(await basePrisma.message.count({ where: { teamId: TEAM, conteudo: "Pare" } })).toBe(1);
    expect(await basePrisma.campaignRecipient.count({ where: { contactId: c.contato.id, status: "opted_out" } })).toBe(1);
  });

  it("dois pedidos AO MESMO TEMPO: uma tag, uma nota", async () => {
    const c = await cenario(TEAM);
    await receber(c.conta.externalId!, "Oi"); // a conversa já existe (a corrida que interessa é a do opt-out)
    await Promise.all([receber(c.conta.externalId!, "Pare"), receber(c.conta.externalId!, "Sair"), receber(c.conta.externalId!, "STOP")]);
    const contato = await contatoDe(c.contato.id);
    expect(contato.relacionamentoStatus).toBe("opt_out");
    expect(contato.tags.filter((t) => t === TAG_PEDIU_PARA_SAIR)).toHaveLength(1);
    expect(await notasDeSaida(c.contato.id)).toBe(1);
  });

  it("adiamento não é opt-out: a resposta segue o caminho normal (fluxo de resposta inscrito)", async () => {
    const c = await cenario(TEAM);
    await receber(c.conta.externalId!, "Não quero agora, me chama semana que vem");

    const contato = await contatoDe(c.contato.id);
    expect(contato.relacionamentoStatus).toBe("ja_conversou");
    expect(contato.tags).not.toContain(TAG_PEDIU_PARA_SAIR);
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: c.ativa.id } })).toMatchObject({ status: "active" });
    expect(await basePrisma.enrollment.count({ where: { flowId: c.aoResponder.id } })).toBe(1);
    // Resposta normal: a campanha marca "respondeu" (A.2b), não "saiu".
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: c.recebeu.id } })).toMatchObject({ status: "replied" });
    expect(await notasDeSaida(c.contato.id)).toBe(0);
  });

  it("campanha antiga (> 30 dias) não leva o opt-out; a fila pendente é pulada mesmo assim", async () => {
    const c = await cenario(TEAM);
    await basePrisma.campaignRecipient.update({ where: { id: c.recebeu.id }, data: { sentAt: new Date(Date.now() - 40 * DIA) } });
    await receber(c.conta.externalId!, "sair");
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: c.recebeu.id } })).toMatchObject({ status: "delivered" });
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: c.naFila.id } })).toMatchObject({ status: "skipped" });
    expect((await contatoDe(c.contato.id)).relacionamentoStatus).toBe("opt_out");
  });

  it("dois times: o mesmo número no time B não é tocado quando o A recebe o pedido", async () => {
    const a = await cenario(TEAM);
    const b = await cenario(OUTRO);
    await receber(a.conta.externalId!, "Pare");

    expect((await contatoDe(a.contato.id)).relacionamentoStatus).toBe("opt_out");
    const contatoB = await contatoDe(b.contato.id);
    expect(contatoB.relacionamentoStatus).toBe("novo");
    expect(contatoB.tags).not.toContain(TAG_PEDIU_PARA_SAIR);
    expect(await basePrisma.enrollment.count({ where: { teamId: OUTRO, status: { in: ["active", "waiting"] } } })).toBe(2);
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: b.recebeu.id } })).toMatchObject({ status: "delivered" });
    expect(await basePrisma.campaignRecipient.findUniqueOrThrow({ where: { id: b.naFila.id } })).toMatchObject({ status: "queued" });
  });
});

describe("marcarOptOut (pela tela)", () => {
  it("member marca; viewer não pode; contato de outro time é recusado", async () => {
    const a = await cenario(TEAM);
    const b = await cenario(OUTRO);
    await expect(runWithTeam(TEAM, () => marcarOptOut(a.contato.id), { userId: "v", role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeam(TEAM, () => marcarOptOut(b.contato.id))).rejects.toThrow();
    expect((await contatoDe(b.contato.id)).relacionamentoStatus).toBe("novo");

    const r = await runWithTeam(TEAM, () => marcarOptOut(a.contato.id), { userId: "m", role: "member" });
    expect(r).toMatchObject({ novo: true, inscricoesEncerradas: 2, campanhaSaiu: 1, campanhasPuladas: 1 });
    const nota = await basePrisma.activity.findFirstOrThrow({ where: { contactId: a.contato.id, tipo: "note" } });
    expect(nota.conteudo).toContain("marcado pelo vendedor");
  });
});
