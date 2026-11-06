import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/** Passo "Registrar conversa no histórico". Evolution e importador de mensagens MOCKADOS; contato descartável. */
vi.mock("./queue", () => ({
  scheduleStep: vi.fn(),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));
type ChamadaEvo = { number: string; instance: string; jidsExtras?: string[] };
const evo = vi.hoisted(() => ({
  msgs: [] as unknown[],
  ultima: null as null | ChamadaEvo,
  chamadas: [] as string[],
  /** Mensagens de uma instância específica (a que não está aqui devolve `msgs`). */
  porInstancia: {} as Record<string, unknown[]>,
  /** Instância que falha com este erro. */
  falha: {} as Record<string, string>,
}));
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  return {
    ...real,
    fetchWhatsAppChatMessages: async (i: ChamadaEvo) => {
      evo.ultima = i;
      evo.chamadas.push(i.instance);
      if (evo.falha[i.instance]) throw new Error(evo.falha[i.instance]);
      return evo.porInstancia[i.instance] ?? evo.msgs;
    },
  };
});
vi.mock("../integrations/whatsapp-historico", () => ({ importarPaginaHistorico: async () => 0 }));

const { registrarConversaNoHistorico } = await import("./registrar-historico");
const { executeNode } = await import("./executor");

const TEAM = "00000000-0000-0000-0000-0000000000d5";
const sufixo = Math.random().toString(36).slice(2, 8);
let contatoId = "";
let contaId = "";

const msg = (id: string, fromMe: boolean, text: string, ts: number) => ({ providerMessageId: id, fromMe, text, media: null, timestamp: ts, from: "+5565999990000", name: null, instance: `hist-${sufixo}` });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team registrar histórico" } });
});

beforeEach(async () => {
  for (const m of ["activity", "channelIdentifier", "contact", "channelAccount", "whatsAppLid"] as const) await (basePrisma[m] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  contaId = (await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `hist-${sufixo}`, status: "connected", credentials: { instance: `hist-${sufixo}` } } })).id;
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead Histórico" } })).id;
  evo.msgs = [msg("A1", false, "Oi, tudo bem?", 1_700_000_000), msg("A2", true, "Tudo, e você?", 1_700_000_060), msg("A3", false, "Quanto custa?", 1_700_000_120)];
  evo.chamadas = [];
  evo.porInstancia = {};
  evo.falha = {};
});

afterAll(async () => {
  for (const m of ["activity", "channelIdentifier", "contact", "channelAccount", "whatsAppLid"] as const) await (basePrisma[m] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
});

const registrar = () => runWithTeam(TEAM, () => registrarConversaNoHistorico({ teamId: TEAM, accountId: contaId, instance: `hist-${sufixo}`, contactId: contatoId, numero: "+5565999990000" }));

describe("registrarConversaNoHistorico", () => {
  it("registra a conversa inteira no histórico, com a hora e a direção originais", async () => {
    expect(await registrar()).toEqual({ mensagens: 3, novasNoHistorico: 3 });
    const acts = await basePrisma.activity.findMany({ where: { contactId: contatoId }, orderBy: { createdAt: "asc" } });
    expect(acts.map((a) => [a.direcao, a.conteudo])).toEqual([["in", "Oi, tudo bem?"], ["out", "Tudo, e você?"], ["in", "Quanto custa?"]]);
    expect(acts[0]!.createdAt.getTime()).toBe(1_700_000_000_000);
    expect(acts[0]!.tipo).toBe("whatsapp");
  });

  it("rodar de novo não duplica; mensagem nova entra sozinha", async () => {
    await registrar();
    expect(await registrar()).toEqual({ mensagens: 3, novasNoHistorico: 0 });
    evo.msgs = [...evo.msgs, msg("A4", true, "Mando a proposta.", 1_700_000_300)];
    expect(await registrar()).toEqual({ mensagens: 4, novasNoHistorico: 1 });
    expect(await basePrisma.activity.count({ where: { contactId: contatoId } })).toBe(4);
  });

  it("não duplica o que a plataforma já registrou ao vivo (mesmo texto, direção e hora próxima)", async () => {
    await basePrisma.activity.create({ data: { teamId: TEAM, contactId: contatoId, tipo: "whatsapp", direcao: "in", conteudo: "Oi, tudo bem?", createdAt: new Date(1_700_000_005_000) } });
    expect(await registrar()).toEqual({ mensagens: 3, novasNoHistorico: 2 });
  });

  it("busca também pelo código anônimo (@lid) guardado para o número", async () => {
    await basePrisma.whatsAppLid.create({ data: { teamId: TEAM, lid: "184469901234567@lid", telefone: "+5565999990000", origem: "manual" } });
    await registrar();
    expect(evo.ultima?.jidsExtras).toEqual(["184469901234567@lid"]);
  });

  it("conversa vazia não registra nada", async () => {
    evo.msgs = [];
    expect(await registrar()).toEqual({ mensagens: 0, novasNoHistorico: 0 });
  });
});

describe("passo save_history no motor", () => {
  const rodar = (config: object = {}) =>
    runWithTeam(TEAM, () =>
      executeNode(
        { id: "enr-x", teamId: TEAM, contactId: contatoId, lastOutboundAt: null, round: 1, contact: { id: contatoId, nome: "Lead Histórico", tags: [], ownerId: null, relacionamentoStatus: "novo" } } as never,
        { id: "n-hist", tipo: "save_history", config, nextNodeId: "n-fim" } as never,
      ),
    );

  it("sem número de WhatsApp cadastrado: segura o passo como 'sem cadastro' e não registra nada", async () => {
    const r = await rodar();
    expect(r).toMatchObject({ hold: true, skipped: true, nextNodeId: "n-hist" });
    expect(r.motivo).toMatch(/Sem cadastro/);
    expect(await basePrisma.activity.count({ where: { contactId: contatoId } })).toBe(0);
  });

  it("com o número cadastrado: registra e segue para o próximo passo", async () => {
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5565999990000", isPrimary: true } });
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: "n-fim" });
    expect(r.hold).toBeUndefined();
    expect(r.motivo).toBe("3 mensagem(ns) nova(s) no histórico, de 3 na conversa");
    expect(await basePrisma.activity.count({ where: { contactId: contatoId } })).toBe(3);
  });

  it("conta de WhatsApp desconectada agora: o passo só lê, então segue normalmente", async () => {
    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { status: "disconnected" } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5565999990000", isPrimary: true } });
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: "n-fim" });
    expect(r.hold).toBeUndefined();
  });

  it("número cadastrado mas sem conversa: pula e explica, inclusive o limite do código anônimo (@lid)", async () => {
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5565999990000", isPrimary: true } });
    evo.msgs = [];
    const r = await rodar();
    expect(r).toMatchObject({ nextNodeId: "n-fim", skipped: true });
    expect(r.motivo).toMatch(/^Sem conversa encontrada para este número no número de WhatsApp do CRM Agro\./);
    expect(r.motivo).toMatch(/@lid/);
  });

  describe("vários números de WhatsApp no time", () => {
    const outraConta = async (instance: string, status: "connected" | "disconnected" = "disconnected", createdAt = new Date("2020-01-01")) =>
      (await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label: "WA 2", provider: "evolution", externalId: instance, status, credentials: { instance }, createdAt } })).id;
    const inst2 = () => `hist2-${sufixo}`;

    beforeEach(async () => {
      await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contatoId, canal: "whatsapp", valor: "+5565999990000", isPrimary: true } });
    });

    it("automático: lê TODOS os números do time, o conectado primeiro, e soma", async () => {
      await outraConta(inst2()); // mais antiga, mas desconectada
      evo.porInstancia[inst2()] = [msg("B1", false, "Oi de novo", 1_700_000_500)];
      const r = await rodar();
      expect(evo.chamadas).toEqual([`hist-${sufixo}`, inst2()]);
      expect(r).toMatchObject({ nextNodeId: "n-fim" });
      expect(r.motivo).toBe("4 mensagem(ns) nova(s) no histórico, de 4 na conversa");
      expect(await basePrisma.activity.count({ where: { contactId: contatoId } })).toBe(4);
    });

    it("com o número escolhido no passo, lê só ele", async () => {
      const id2 = await outraConta(inst2(), "connected");
      evo.porInstancia[inst2()] = [msg("B1", false, "Só deste", 1_700_000_500)];
      const r = await rodar({ channelAccountId: id2 });
      expect(evo.chamadas).toEqual([inst2()]);
      expect(r.motivo).toBe("1 mensagem(ns) nova(s) no histórico, de 1 na conversa");
    });

    it("um número falha e o outro acha a conversa: segue e avisa quantos não responderam", async () => {
      await outraConta(inst2());
      evo.falha[inst2()] = "Evolution fora do ar";
      const r = await rodar();
      expect(r).toMatchObject({ nextNodeId: "n-fim" });
      expect(r.motivo).toBe("3 mensagem(ns) nova(s) no histórico, de 3 na conversa (1 de 2 números não responderam)");
    });

    it("um número falha e nenhum outro achou nada: o erro sobe (nunca 'sem conversa' por engano)", async () => {
      await outraConta(inst2());
      evo.msgs = [];
      evo.falha[inst2()] = "Evolution fora do ar";
      await expect(rodar()).rejects.toThrow("Evolution fora do ar");
    });

    it("todos falham: o erro sobe", async () => {
      await outraConta(inst2());
      evo.falha[`hist-${sufixo}`] = "Evolution fora do ar";
      evo.falha[inst2()] = "Evolution fora do ar";
      await expect(rodar()).rejects.toThrow("Evolution fora do ar");
    });

    it("sem conversa em nenhum número: o motivo diz quantos conferiu", async () => {
      await outraConta(inst2());
      evo.msgs = [];
      const r = await rodar();
      expect(r).toMatchObject({ nextNodeId: "n-fim", skipped: true });
      expect(r.motivo).toMatch(/nos 2 números de WhatsApp do CRM Agro/);
    });
  });
});
