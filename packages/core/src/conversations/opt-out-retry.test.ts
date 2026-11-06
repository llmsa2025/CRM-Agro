import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

/**
 * Opt-out junto com a mensagem (auditoria do #112, sugestão 3): o worker cai
 * no meio do `receiveInbound` e a fila refaz o job. Antes, o opt-out rodava
 * DEPOIS de gravar a mensagem: a queda entre os dois fazia o retry cair no
 * dedup e o pedido de saída se perdia. Agora a mensagem e o opt-out entram na
 * mesma transação. Fila do motor mockada; nada é enviado.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));

// Queda simulada 1: DEPOIS do commit (no passo seguinte, a prévia da conversa).
const quedaAposCommit = { ativa: false };
vi.mock("./ultima-mensagem", async (orig) => {
  const real = await orig<typeof import("./ultima-mensagem")>();
  return {
    ...real,
    touchConversation: async (...a: Parameters<typeof real.touchConversation>) => {
      if (quedaAposCommit.ativa) {
        quedaAposCommit.ativa = false;
        throw new Error("worker caiu depois de gravar a mensagem");
      }
      return real.touchConversation(...a);
    },
  };
});

// Queda simulada 2: NO MEIO da transação, logo no opt-out.
const quedaNoOptOut = { ativa: false };
vi.mock("./opt-out", async (orig) => {
  const real = await orig<typeof import("./opt-out")>();
  return {
    ...real,
    optOutNaTransacao: async (...a: Parameters<typeof real.optOutNaTransacao>) => {
      if (quedaNoOptOut.ativa && real.classificarOptOut(a[1].texto).optOut) {
        quedaNoOptOut.ativa = false;
        throw new Error("worker caiu no meio da transação");
      }
      return real.optOutNaTransacao(...a);
    },
  };
});

const { receiveInbound } = await import("./service");
const { TAG_PEDIU_PARA_SAIR } = await import("./opt-out");

const TEAM = "00000000-0000-0000-0000-0000000002b2";
const OUTRO = "00000000-0000-0000-0000-0000000002b3";
const sufixo = Math.random().toString(36).slice(2, 8);
const NUMERO = "5565955550202";
let seq = 0;

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Opt-out retry (test)"], [OUTRO, "Team Opt-out retry B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  quedaAposCommit.ativa = false;
  quedaNoOptOut.ativa = false;
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
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

async function cenario(teamId: string) {
  const conta = await basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `retry-${teamId.slice(-3)}-${sufixo}`, status: "connected" },
  });
  const contato = await basePrisma.contact.create({ data: { teamId, nome: `Lead ${seq++}` } });
  await basePrisma.channelIdentifier.create({ data: { teamId, contactId: contato.id, canal: "whatsapp", valor: NUMERO, isPrimary: true } });
  const fluxo = await basePrisma.flow.create({ data: { teamId, nome: `Cadência ${seq++}`, triggerType: "manual", status: "active" } });
  await basePrisma.flowNode.create({ data: { id: `n-${fluxo.id}`, teamId, flowId: fluxo.id, tipo: "wait" as never, config: {} as never } });
  const inscricao = await basePrisma.enrollment.create({
    data: { teamId, flowId: fluxo.id, contactId: contato.id, currentNodeId: `n-${fluxo.id}`, currentRound: 1, status: "active", nextRunAt: new Date() },
  });
  return { conta, contato, inscricao };
}

/** A mesma entrega da Evolution (mesmo providerMessageId) — o que a fila refaz no retry. */
const entrega = (instance: string, text: string, id: string) => () =>
  receiveInbound({ from: NUMERO, fromMe: false, text, media: null, providerMessageId: id, timestamp: null, name: "Lead", instance });

const estado = async (contactId: string) => {
  const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
  return {
    status: c.relacionamentoStatus,
    tags: (c.tags ?? []).filter((t) => t === TAG_PEDIU_PARA_SAIR).length,
    notas: await basePrisma.activity.count({ where: { contactId, tipo: "note", meta: { path: ["optOut"], equals: true } } }),
    mensagens: await basePrisma.message.count({ where: { conversation: { contactId } } }),
  };
};

describe("opt-out não se perde numa queda do worker", () => {
  it("queda DEPOIS de gravar: o opt-out já entrou junto; o retry cai no dedup sem duplicar nada", async () => {
    const c = await cenario(TEAM);
    const pare = entrega(c.conta.externalId!, "Pare", `RETRY-${sufixo}-a`);

    quedaAposCommit.ativa = true;
    await expect(pare()).rejects.toThrow("worker caiu");
    // A mensagem ficou gravada — e o opt-out também (antes: só a mensagem).
    expect(await estado(c.contato.id)).toEqual({ status: "opt_out", tags: 1, notas: 1, mensagens: 1 });
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: c.inscricao.id } })).status).toBe("done");

    await pare(); // retry da fila
    expect(await estado(c.contato.id)).toEqual({ status: "opt_out", tags: 1, notas: 1, mensagens: 1 });
  });

  it("queda NO MEIO da transação: nada fica pela metade; o retry grava a mensagem E aplica o opt-out", async () => {
    const c = await cenario(TEAM);
    const pare = entrega(c.conta.externalId!, "me tira dessa lista", `RETRY-${sufixo}-b`);

    quedaNoOptOut.ativa = true;
    await expect(pare()).rejects.toThrow("worker caiu");
    // Rollback: nem a mensagem, nem o opt-out (o job ainda não "passou").
    expect(await estado(c.contato.id)).toEqual({ status: "novo", tags: 0, notas: 0, mensagens: 0 });
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: c.inscricao.id } })).status).toBe("active");

    await pare(); // retry da fila
    expect(await estado(c.contato.id)).toEqual({ status: "opt_out", tags: 1, notas: 1, mensagens: 1 });
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: c.inscricao.id } })).status).toBe("done");
  });

  it("mensagem comum não passa pelo opt-out; dois times: o B com o mesmo número não é tocado", async () => {
    const a = await cenario(TEAM);
    const b = await cenario(OUTRO);
    await entrega(a.conta.externalId!, "Bom dia, pode mandar a tabela", `RETRY-${sufixo}-c`)();
    expect(await estado(a.contato.id)).toMatchObject({ status: "ja_conversou", tags: 0, notas: 0 });

    quedaAposCommit.ativa = true;
    await expect(entrega(a.conta.externalId!, "PARE", `RETRY-${sufixo}-d`)()).rejects.toThrow();
    expect(await estado(a.contato.id)).toMatchObject({ status: "opt_out", tags: 1, notas: 1 });
    expect(await estado(b.contato.id)).toEqual({ status: "novo", tags: 0, notas: 0, mensagens: 0 });
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: b.inscricao.id } })).status).toBe("active");
  });
});
