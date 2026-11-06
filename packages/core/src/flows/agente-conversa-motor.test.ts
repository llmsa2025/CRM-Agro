import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import type { JanelaEnvio } from "./janela";
import type { NodeResult } from "./executor";
import type { TurnoDaConversa, TurnoDaConversaInput } from "../ai/flow-conversa";

/**
 * Agente de CONVERSA (`ai_agent`, modo "conversa") no motor. O CANAL E A IA SÃO MOCKADOS: nenhuma mensagem
 * sai para a Evolution, nenhuma chamada vai ao provedor de IA, e o contato é descartável (nunca um real).
 *
 * Cada `rodar()` faz o que o worker faz num passo: abre o passo (round + 1), executa o nó e grava o `result`
 * (é de lá que o turno seguinte lê o estado do agente).
 */
const scheduleStep = vi.fn(async () => {});
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => scheduleStep(...(a as [])),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

const canal = vi.hoisted(() => ({
  n: 0,
  send: vi.fn(async (_: unknown) => ({ providerMessageId: "WAMID-FAKE" })),
  historico: vi.fn(async (): Promise<boolean | null> => false),
}));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  const falso = { send: canal.send };
  return {
    ...real,
    getChannelProvider: () => falso,
    defaultEvolutionProvider: () => falso,
    hasWhatsAppHistory: () => canal.historico(),
  };
});

const ia = vi.hoisted(() => ({ gerar: vi.fn() }));
vi.mock("../ai/flow-conversa", () => ({ gerarTurnoDaConversa: (i: unknown) => ia.gerar(i) }));

const { executeNode } = await import("./executor");
const { reservarEnvioAoContato } = await import("./limites");

const TEAM = "00000000-0000-0000-0000-0000000000a7";
const sufixo = Math.random().toString(36).slice(2, 8);
const NUMERO = "5565977776666";
const N1 = `ag-n1-${sufixo}`;
const N2 = `ag-n2-${sufixo}`;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

let contaId = "";
let contatoId = "";
let flowId = "";
let enrollmentId = "";
let round = 0;
let lastOutboundAt: Date | null = null;

type Cfg = Record<string, unknown>;
const CFG: Cfg = { modo: "conversa", canal: "whatsapp", orientacao: "Apresentar o adubo e propor uma conversa de 15 min." };

/** O que a IA responde por padrão: uma mensagem, lendo a última mensagem do contato do banco como a de verdade. */
async function turnoPadrao(input: TurnoDaConversaInput, decisao: TurnoDaConversa["decisao"]): Promise<TurnoDaConversa> {
  const lidoEm = new Date();
  const ultimo = await basePrisma.message.findFirst({ where: { conversationId: input.conversationId, direcao: "in" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return { decisao, ultimoInboundEm: ultimo?.createdAt ?? null, lidoEm };
}
const iaResponde = (texto = "Oi! Tudo bem?") => ia.gerar.mockImplementation((i: TurnoDaConversaInput) => turnoPadrao(i, { acao: "responder", texto }));
const iaDecide = (decisao: TurnoDaConversa["decisao"]) => ia.gerar.mockImplementation((i: TurnoDaConversaInput) => turnoPadrao(i, decisao));

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Agente Conversa (test)" } });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  ia.gerar.mockReset();
  iaResponde();
  canal.send.mockReset();
  canal.send.mockImplementation(async () => ({ providerMessageId: `WAMID-${sufixo}-${++canal.n}` }));
  canal.historico.mockReset();
  canal.historico.mockImplementation(async () => false);
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const conta = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `ag-${sufixo}`, credentials: { instance: `ag-${sufixo}` }, status: "connected" },
  });
  contaId = conta.id;
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead Teste" } });
  contatoId = contato.id;
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true } });
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: "F", triggerType: "manual", status: "active" } });
  flowId = flow.id;
  const enr = await basePrisma.enrollment.create({
    data: { teamId: TEAM, flowId, contactId: contatoId, currentNodeId: N1, currentRound: 1, status: "active", nextRunAt: new Date() },
  });
  enrollmentId = enr.id;
  round = 0;
  lastOutboundAt = null;
});

afterEach(() => {
  vi.useRealTimers();
  process.env.FLOW_JANELA_ENVIO = "off";
});

const no = (cfg: Cfg = CFG) => ({ id: N1, tipo: "ai_agent", config: cfg, nextNodeId: N2 }) as never;

/** Um passo do worker: abre o passo, executa o nó e grava o resultado. */
async function rodar(cfg: Cfg = CFG, extra: { janelaEnvio?: JanelaEnvio; optOut?: boolean } = {}): Promise<NodeResult> {
  round += 1;
  await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId, nodeId: N1, round, status: "running" } });
  const r = await runWithTeam(TEAM, () =>
    executeNode(
      {
        id: enrollmentId,
        teamId: TEAM,
        contactId: contatoId,
        lastOutboundAt,
        round,
        janelaEnvio: extra.janelaEnvio,
        contact: { id: contatoId, nome: "Lead Teste", tags: [], ownerId: null, relacionamentoStatus: extra.optOut ? "opt_out" : null },
      },
      no(cfg),
    ),
  );
  await basePrisma.flowStepExecution.updateMany({ where: { enrollmentId, nodeId: N1, round }, data: { status: "done", result: r as never } });
  lastOutboundAt = r.sideEffects?.lastOutboundAt ?? lastOutboundAt;
  return r;
}

async function conversa() {
  return basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, contactId: contatoId } });
}
async function doContato(texto: string) {
  await dormir(8);
  const c = await conversa();
  return basePrisma.message.create({
    data: { teamId: TEAM, conversationId: c.id, direcao: "in", tipo: "text", conteudo: texto, providerMessageId: `IN-${sufixo}-${++canal.n}` } as never,
  });
}
async function deUmaPessoa(texto: string) {
  await dormir(8);
  const c = await conversa();
  return basePrisma.message.create({
    data: { teamId: TEAM, conversationId: c.id, direcao: "out", tipo: "text", conteudo: texto, providerMessageId: `HUM-${sufixo}-${++canal.n}` } as never,
  });
}
async function usoDoDia() {
  const u = await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: contaId } });
  return u?.sent ?? 0;
}
const tagsDoContato = async () => (await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoId } })).tags;
const avisos = () => basePrisma.activity.findMany({ where: { teamId: TEAM, contactId: contatoId, tipo: "note" } });

/** Abre a conversa, o contato responde e o agente passa da pausa: pronto para falar a resposta. */
async function ateAPreparacao(texto = "Quanto custa?") {
  await rodar();
  await doContato(texto);
  const r = await rodar();
  expect(r.agente?.acao).toBe("preparando");
}

describe("agente de conversa: abertura", () => {
  it("fala primeiro seguindo a orientação e passa a esperar a resposta", async () => {
    iaResponde("Oi, tudo bem? Posso te contar rápido sobre o adubo?");
    const r = await rodar();

    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(canal.send.mock.calls[0]![0]).toMatchObject({ content: { text: "Oi, tudo bem? Posso te contar rápido sobre o adubo?" } });
    expect(ia.gerar).toHaveBeenCalledWith(expect.objectContaining({ abertura: true, enviadas: 0, orientacao: CFG.orientacao, maxRespostas: 6 }));
    expect(r).toMatchObject({ nextNodeId: N1, agente: { acao: "esperando", enviadas: 1, falhas: 0 } });
    expect(r.aguardandoResposta?.ate.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(r.sideEffects?.lastOutboundAt).toBeInstanceOf(Date);
    const msgs = await basePrisma.message.findMany({ where: { teamId: TEAM, direcao: "out" } });
    expect(msgs).toHaveLength(1);
    expect(await usoDoDia()).toBe(1);
  });

  it("sem orientação não fala nada e segue o fluxo", async () => {
    const r = await rodar({ ...CFG, orientacao: "   " });
    expect(r).toMatchObject({ nextNodeId: N2, skipped: true, motivo: "agente sem orientação" });
    expect(canal.send).not.toHaveBeenCalled();
  });

  it("contato que pediu para sair (opt-out) não recebe nada e o fluxo encerra", async () => {
    const r = await rodar(CFG, { optOut: true });
    expect(r).toMatchObject({ nextNodeId: null, skipped: true });
    expect(canal.send).not.toHaveBeenCalled();
    expect(ia.gerar).not.toHaveBeenCalled();
  });

  it("já tem conversa fora da plataforma: pula (só na abertura)", async () => {
    canal.historico.mockImplementation(async () => true);
    const r = await rodar({ ...CFG, skipIfHistory: true });
    expect(r).toMatchObject({ nextNodeId: N2, skipped: true, motivo: "já tem conversa no WhatsApp" });
    expect(canal.send).not.toHaveBeenCalled();
  });

  it("fora do horário do fluxo: adia, não fala e não gasta cota", async () => {
    process.env.FLOW_JANELA_ENVIO = "on";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T02:00:00-03:00")); // sábado de madrugada
    const propria: JanelaEnvio = { modo: "propria", abertura: "09:00", fechamento: "17:00", dias: ["mon", "tue", "wed", "thu", "fri"], feriados: true };
    const r = await rodar(CFG, { janelaEnvio: propria });
    expect(r).toMatchObject({ nextNodeId: N1, deferred: true, motivo: "fora do horário de envio" });
    expect(canal.send).not.toHaveBeenCalled();
    expect(await usoDoDia()).toBe(0);
  });

  it("o limite de 3 envios por contato em 24 h segura a ABERTURA", async () => {
    for (let i = 0; i < 3; i++) await reservarEnvioAoContato(contatoId);
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N1, deferred: true });
    expect(r.motivo).toContain("limite");
    expect(canal.send).not.toHaveBeenCalled();
  });
});

describe("agente de conversa: espera e resposta", () => {
  it("ninguém respondeu e o prazo não acabou: continua esperando sem falar", async () => {
    await rodar();
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N1, agente: { acao: "esperando", enviadas: 1 } });
    expect(r.aguardandoResposta?.ate.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // Uma conferência a cada 6 h, não a cada hora: espera de dias não pode estourar o teto de passos.
    expect(r.delayMs).toBeGreaterThanOrEqual(5 * 3_600_000);
    expect(r.delayMs).toBeLessThanOrEqual(6 * 3_600_000);
    expect(canal.send).toHaveBeenCalledTimes(1);
  });

  it("o contato responde: faz uma pausa humana, depois responde lendo o histórico", async () => {
    await rodar();
    await doContato("Quanto custa?");
    const pausa = await rodar();
    expect(pausa).toMatchObject({ nextNodeId: N1, agente: { acao: "preparando", enviadas: 1 } });
    expect(pausa.delayMs!).toBeGreaterThanOrEqual(8_000);
    expect(pausa.delayMs!).toBeLessThanOrEqual(20_000);
    expect(canal.send).toHaveBeenCalledTimes(1);

    iaResponde("Depende da área. Quantos hectares você tem?");
    const fala = await rodar();
    expect(canal.send).toHaveBeenCalledTimes(2);
    expect(ia.gerar).toHaveBeenLastCalledWith(expect.objectContaining({ abertura: false, enviadas: 1 }));
    expect(fala).toMatchObject({ nextNodeId: N1, agente: { acao: "esperando", enviadas: 2 } });
    expect(fala.aguardandoResposta).toBeDefined();
  });

  it("depois de a conversa começar, a resposta NÃO esbarra no limite de 3 envios por contato", async () => {
    await rodar(); // abertura: reserva 1
    await reservarEnvioAoContato(contatoId);
    await reservarEnvioAoContato(contatoId); // 3 de 3
    await doContato("Quanto custa?");
    await rodar();
    await rodar();
    expect(canal.send).toHaveBeenCalledTimes(2);
  });

  it("o contato escreveu enquanto a IA pensava: reavalia na hora, sem esperar um evento que não vem", async () => {
    await rodar();
    await doContato("Oi");
    await rodar(); // preparando
    ia.gerar.mockImplementation(async (i: TurnoDaConversaInput) => {
      const turno = await turnoPadrao(i, { acao: "responder", texto: "Claro, me conta mais." });
      await doContato("Esqueci de dizer: tenho 200 hectares"); // chega depois de a IA ler o histórico
      return turno;
    });
    const fala = await rodar();
    expect(fala).toMatchObject({ agente: { acao: "esperando", enviadas: 2 } });
    expect(fala.aguardandoResposta).toBeUndefined();
    expect(fala.delayMs).toBe(5_000);
    iaResponde("Ótimo, com 200 hectares dá para pensar num plano.");
    expect((await rodar()).agente?.acao).toBe("preparando");
  });

  it("silêncio do contato além do prazo: encerra e o fluxo segue, sem avisar o vendedor", async () => {
    await rodar();
    const passo = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId, round: 1 } });
    const r1 = passo.result as { agente: { enviadoEm: string } };
    r1.agente.enviadoEm = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await basePrisma.flowStepExecution.update({ where: { id: passo.id }, data: { result: r1 as never } });

    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N2, agente: { acao: "encerrou", fim: "silencio" } });
    expect(await avisos()).toHaveLength(0);
    expect(canal.send).toHaveBeenCalledTimes(1);
  });

  it("prazo de silêncio próprio do nó (silencioHoras)", async () => {
    const cfg = { ...CFG, silencioHoras: 2 };
    await rodar(cfg);
    const passo = await basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId, round: 1 } });
    const r1 = passo.result as { agente: { enviadoEm: string } };
    r1.agente.enviadoEm = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await basePrisma.flowStepExecution.update({ where: { id: passo.id }, data: { result: r1 as never } });
    expect((await rodar(cfg)).agente?.fim).toBe("silencio");
  });
});

describe("agente de conversa: quando para", () => {
  it("uma pessoa respondeu na conversa depois do agente: ele se cala", async () => {
    await rodar();
    await deUmaPessoa("Oi, aqui é o João, pode deixar que eu continuo.");
    await doContato("Beleza");
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N2, agente: { acao: "encerrou", fim: "pessoa_respondeu" } });
    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(await avisos()).toHaveLength(0);
  });

  it("uma pessoa respondeu durante a pausa: não fala por cima", async () => {
    await ateAPreparacao();
    await deUmaPessoa("Já respondi por aqui!");
    const r = await rodar();
    expect(r.agente).toMatchObject({ acao: "encerrou", fim: "pessoa_respondeu" });
    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(ia.gerar).toHaveBeenCalledTimes(1); // só a abertura: nem chamou a IA
  });

  it("a IA passa para uma pessoa: avisa o vendedor, marca o contato e o fluxo segue", async () => {
    await ateAPreparacao("Quanto custa o pacote de 200 hectares?");
    iaDecide({ acao: "passar_para_humano", motivo: "pediu preço de 200 hectares" });
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N2, agente: { acao: "encerrou", fim: "passou_para_pessoa" } });
    expect(r.motivo).toContain("pediu preço de 200 hectares");
    expect(canal.send).toHaveBeenCalledTimes(1); // sem frase: nada sai
    expect(await tagsDoContato()).toContain("IA: precisa de uma pessoa");
    const a = await avisos();
    expect(a).toHaveLength(1);
    expect(a[0]!.conteudo).toContain("pediu preço de 200 hectares");
    expect(a[0]!.meta).toMatchObject({ kind: "flow_notify", origem: "agente_ia" });
    expect(await usoDoDia()).toBe(1); // a cota da resposta que não saiu voltou
  });

  it("a IA passa para uma pessoa com uma frase de transição: a frase sai e conta como mensagem", async () => {
    await ateAPreparacao();
    iaDecide({ acao: "passar_para_humano", motivo: "quer fechar", texto: "Vou pedir para alguém do time te chamar por aqui." });
    const r = await rodar();
    expect(canal.send).toHaveBeenCalledTimes(2);
    expect(r.agente).toMatchObject({ acao: "encerrou", fim: "passou_para_pessoa", enviadas: 2 });
    expect(r.sideEffects?.lastOutboundAt).toBeInstanceOf(Date);
  });

  it("avisarVendedor desligado: marca o contato mas não cria o aviso", async () => {
    const cfg = { ...CFG, avisarVendedor: false };
    await rodar(cfg);
    await doContato("Quero falar com alguém");
    await rodar(cfg);
    iaDecide({ acao: "passar_para_humano", motivo: "pediu uma pessoa" });
    await rodar(cfg);
    expect(await tagsDoContato()).toContain("IA: precisa de uma pessoa");
    expect(await avisos()).toHaveLength(0);
  });

  it("a IA encerra (sem interesse): despedida sai, o vendedor não é avisado", async () => {
    await ateAPreparacao("Não tenho interesse, obrigado");
    iaDecide({ acao: "encerrar", motivo: "sem interesse", texto: "Tudo bem, obrigado pelo retorno!" });
    const r = await rodar();
    expect(canal.send).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ nextNodeId: N2, agente: { acao: "encerrou", fim: "encerrado_pela_ia" } });
    expect(await avisos()).toHaveLength(0);
    expect(await tagsDoContato()).not.toContain("IA: precisa de uma pessoa");
  });

  it("limite de mensagens do nó: com o contato ainda respondendo, para e avisa o vendedor", async () => {
    const cfg = { ...CFG, maxRespostas: 2 };
    await rodar(cfg); // 1
    await doContato("Oi");
    await rodar(cfg);
    await rodar(cfg); // 2
    await doContato("E aí?");
    const r = await rodar(cfg);
    expect(r).toMatchObject({ nextNodeId: N2, agente: { acao: "encerrou", fim: "limite" } });
    expect(canal.send).toHaveBeenCalledTimes(2);
    expect(await avisos()).toHaveLength(1);
  });

  it("reentrar no nó depois de a conversa acabar começa uma conversa nova", async () => {
    await rodar();
    await deUmaPessoa("Assumi.");
    expect((await rodar()).agente?.fim).toBe("pessoa_respondeu");
    const r = await rodar();
    expect(r.agente).toMatchObject({ acao: "esperando", enviadas: 1 });
    expect(ia.gerar).toHaveBeenLastCalledWith(expect.objectContaining({ abertura: true }));
  });
});

describe("agente de conversa: a IA falha", () => {
  it("falha na abertura: nada sai, a cota volta e tenta de novo em 5 minutos", async () => {
    iaDecide({ acao: "falhou", motivo: "erro" });
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N1, deferred: true, delayMs: 5 * 60_000, agente: { acao: "tentando_de_novo", falhas: 1, enviadas: 0 } });
    expect(canal.send).not.toHaveBeenCalled();
    expect(await usoDoDia()).toBe(0);
  });

  it("a IA volta na segunda tentativa: a conversa abre e as falhas zeram", async () => {
    iaDecide({ acao: "falhou", motivo: "erro" });
    await rodar();
    iaResponde("Oi, tudo bem?");
    const r = await rodar();
    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(ia.gerar).toHaveBeenLastCalledWith(expect.objectContaining({ abertura: true }));
    expect(r.agente).toMatchObject({ acao: "esperando", enviadas: 1, falhas: 0 });
  });

  it("três falhas seguidas: passa para uma pessoa e conta o motivo", async () => {
    iaDecide({ acao: "falhou", motivo: "sem_chave" });
    await rodar();
    await rodar();
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: N2, agente: { acao: "encerrou", fim: "passou_para_pessoa" } });
    expect(r.motivo).toContain("não há chave de IA conectada");
    expect(canal.send).not.toHaveBeenCalled();
    expect((await avisos())[0]!.conteudo).toContain("3 tentativas");
  });

  it("falha numa resposta no meio da conversa: não manda texto de segurança, só tenta de novo", async () => {
    await ateAPreparacao();
    iaDecide({ acao: "falhou", motivo: "saida_recusada" });
    const r = await rodar();
    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ deferred: true, agente: { acao: "tentando_de_novo", falhas: 1, enviadas: 1 } });
    expect(r.motivo).toContain("não está no cadastro");
  });
});

describe("agente de conversa: modo mensagem continua igual", () => {
  it("sem `modo`, é uma mensagem só (nada de estado de conversa)", async () => {
    vi.doMock("../ai/flow-message", () => ({ generateFlowMessage: async () => ({ text: "Olá!", source: "ai" }) }));
    const r = await rodar({ canal: "whatsapp", objetivo: "apresentar" });
    expect(r.agente).toBeUndefined();
    expect(r.nextNodeId).toBe(N2);
    expect(canal.send).toHaveBeenCalledTimes(1);
    expect(ia.gerar).not.toHaveBeenCalled();
    vi.doUnmock("../ai/flow-message");
  });
});
