import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * Regressão do S1 (IDOR por FK) — item 0.1 do plano.
 *
 * Teste "dois times": o time A tenta gravar, com o próprio login, uma FK que
 * aponta para registro do time B. Todo ponto que recebe id do cliente tem de
 * recusar ANTES de escrever, e o registro do time B tem de ficar intacto.
 *
 * A fila do motor é mockada (ver flows.test.ts): enfileirar de verdade faria o
 * worker de produção enviar WhatsApp real.
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { assertOwned, assertOwnedMany, assertOwnedIfPresent, OwnedNotFound } = await import("./assert-owned");
const { createDeal, createStage } = await import("../funnels/service");
const { enroll, redirectEnrollment } = await import("../flows/service");
const { setContactTag, assignTagBulk } = await import("../tags/service");
const { startConversationWithContact, startConversationWithNumber, markRead } = await import(
  "../conversations/service"
);
const { createAppointment, updateAppointment } = await import("../agenda/service");
const { mergeContacts, removeMany } = await import("../contacts/service");
const { createCall, createManualCall, finishManualCall } = await import("../calls/service");
const { NodeNotFound } = await import("../flows/errors");

const TEAM_A = "00000000-0000-0000-0000-0000000000a9";
const TEAM_B = "00000000-0000-0000-0000-0000000000b9";
const TIMES = [TEAM_A, TEAM_B];
/** Ator mínimo do RBAC (fail-closed exige userId + papel). */
const ATOR = { userId: "dono-teste", role: "owner" };

const emA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn, ATOR);

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (assert-owned)"],
    [TEAM_B, "Team B (assert-owned)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  scheduleStep.mockClear();
  const w = { teamId: { in: TIMES } };
  // Ordem: filhos antes dos pais (Deal → Stage é Restrict).
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.linhaDeLigacao.deleteMany({ where: w });
  await basePrisma.integration.deleteMany({ where: w });
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.appointment.deleteMany({ where: w });
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
});

/** Um "mundo" completo por time: contato, funil+etapa, deal, tag, conta, conversa. */
async function criarMundo(teamId: string, sufixo: string) {
  const contato = await basePrisma.contact.create({ data: { teamId, nome: `Contato ${sufixo}` } });
  const funil = await basePrisma.funnel.create({ data: { teamId, nome: `Funil ${sufixo}`, tipo: "vendas" } });
  const etapa = await basePrisma.stage.create({ data: { teamId, funnelId: funil.id, nome: "Novo", ordem: 0 } });
  const deal = await basePrisma.deal.create({
    data: { teamId, funnelId: funil.id, stageId: etapa.id, contactId: contato.id, valor: 0 },
  });
  const tag = await basePrisma.tag.create({ data: { teamId, nome: `Tag ${sufixo}` } });
  const conta = await basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: `WA ${sufixo}`, provider: "evolution", status: "connected" },
  });
  const conversa = await basePrisma.conversation.create({
    data: { teamId, canal: "whatsapp", contactId: contato.id, channelAccountId: conta.id, status: "open", unreadCount: 3 },
  });
  return { contato, funil, etapa, deal, tag, conta, conversa };
}

async function criarDoisMundos() {
  return { a: await criarMundo(TEAM_A, "A"), b: await criarMundo(TEAM_B, "B") };
}

describe("assertOwned — o helper", () => {
  it("aceita id do time e recusa id de outro time, inexistente ou vazio", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(assertOwned("contact", a.contato.id)).resolves.toBeUndefined();
      await expect(assertOwned("contact", b.contato.id)).rejects.toBeInstanceOf(OwnedNotFound);
      await expect(assertOwned("deal", "00000000-0000-0000-0000-00000000dead")).rejects.toBeInstanceOf(OwnedNotFound);
      await expect(assertOwned("contact", "")).rejects.toBeInstanceOf(OwnedNotFound);
    });
  });

  it("em lote: um único id alheio derruba; repetidos contam uma vez; vazio passa", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(assertOwnedMany("contact", [])).resolves.toBeUndefined();
      await expect(assertOwnedMany("contact", [a.contato.id, a.contato.id])).resolves.toBeUndefined();
      await expect(assertOwnedMany("contact", [a.contato.id, b.contato.id])).rejects.toBeInstanceOf(OwnedNotFound);
    });
  });

  it("opcional: null/undefined passam; valor é conferido", async () => {
    const { b } = await criarDoisMundos();
    await emA(async () => {
      await expect(assertOwnedIfPresent("contact", null)).resolves.toBeUndefined();
      await expect(assertOwnedIfPresent("contact", undefined)).resolves.toBeUndefined();
      await expect(assertOwnedIfPresent("contact", b.contato.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
  });

  it("a mensagem não diferencia 'de outro time' de 'não existe'", async () => {
    const { b } = await criarDoisMundos();
    const erroAlheio = await emA(() => assertOwned("contact", b.contato.id)).catch((e: Error) => e);
    const erroInexistente = await emA(() => assertOwned("contact", "x")).catch((e: Error) => e);
    expect((erroAlheio as Error).message.replace(b.contato.id, "ID")).toBe(
      (erroInexistente as Error).message.replace("x", "ID"),
    );
  });
});

describe("dois times — funis", () => {
  it("createDeal recusa contato, funil ou etapa do time B e não grava nada", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      const base = { funnelId: a.funil.id, stageId: a.etapa.id, contactId: a.contato.id };
      await expect(createDeal({ ...base, contactId: b.contato.id })).rejects.toBeInstanceOf(OwnedNotFound);
      await expect(createDeal({ ...base, funnelId: b.funil.id, stageId: b.etapa.id })).rejects.toBeInstanceOf(
        OwnedNotFound,
      );
      await expect(createDeal({ ...base, stageId: b.etapa.id })).rejects.toBeInstanceOf(OwnedNotFound);
    });
    // Só o deal criado no setup continua existindo no time A.
    expect(await basePrisma.deal.count({ where: { teamId: TEAM_A } })).toBe(1);
  });

  it("createDeal recusa etapa de OUTRO funil do mesmo time", async () => {
    const { a } = await criarDoisMundos();
    const outroFunil = await basePrisma.funnel.create({ data: { teamId: TEAM_A, nome: "Outro", tipo: "vendas" } });
    const etapaOutro = await basePrisma.stage.create({
      data: { teamId: TEAM_A, funnelId: outroFunil.id, nome: "X", ordem: 0 },
    });
    await emA(async () => {
      await expect(
        createDeal({ funnelId: a.funil.id, stageId: etapaOutro.id, contactId: a.contato.id }),
      ).rejects.toBeInstanceOf(OwnedNotFound);
    });
  });

  it("createDeal no caminho feliz continua funcionando", async () => {
    const { a } = await criarDoisMundos();
    const deal = await emA(() => createDeal({ funnelId: a.funil.id, stageId: a.etapa.id, contactId: a.contato.id }));
    expect(deal.teamId).toBe(TEAM_A);
  });

  it("createStage recusa funil do time B", async () => {
    const { b } = await criarDoisMundos();
    await emA(async () => {
      await expect(createStage({ funnelId: b.funil.id, nome: "Invasora", ordem: 9 })).rejects.toBeInstanceOf(
        OwnedNotFound,
      );
    });
    expect(await basePrisma.stage.count({ where: { funnelId: b.funil.id } })).toBe(1);
  });
});

describe("dois times — fluxos", () => {
  async function fluxoAtivoA() {
    const flow = await basePrisma.flow.create({
      data: { teamId: TEAM_A, nome: "Fluxo A", triggerType: "manual", status: "active" },
    });
    await basePrisma.flowNode.create({
      data: { id: `n-${flow.id}`, teamId: TEAM_A, flowId: flow.id, tipo: "wait" as never, config: {} as never },
    });
    return flow;
  }

  it("enroll recusa contato do time B e não agenda nada", async () => {
    const { b } = await criarDoisMundos();
    const flow = await fluxoAtivoA();
    await emA(async () => {
      await expect(enroll(b.contato.id, flow.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
    expect(scheduleStep).not.toHaveBeenCalled();
    expect(await basePrisma.enrollment.count({ where: { flowId: flow.id } })).toBe(0);
  });

  it("redirectEnrollment recusa nó fora do snapshot da inscrição", async () => {
    const { a } = await criarDoisMundos();
    const flow = await fluxoAtivoA();
    const enr = await basePrisma.enrollment.create({
      data: {
        teamId: TEAM_A,
        flowId: flow.id,
        contactId: a.contato.id,
        status: "failed",
        currentNodeId: `n-${flow.id}`,
        flowSnapshot: [{ id: `n-${flow.id}`, tipo: "wait", config: {}, nextNodeId: null }],
      },
    });
    await emA(async () => {
      await expect(redirectEnrollment(enr.id, "no-que-nao-existe")).rejects.toBeInstanceOf(NodeNotFound);
    });
    expect(scheduleStep).not.toHaveBeenCalled();
  });
});

describe("dois times — tags", () => {
  it("setContactTag recusa contato do time B", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(setContactTag(b.contato.id, a.tag.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
    expect(await basePrisma.contactTag.count({ where: { contactId: b.contato.id } })).toBe(0);
  });

  it("assignTagBulk recusa o lote inteiro se houver um contato do time B", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(assignTagBulk([a.contato.id, b.contato.id], a.tag.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
    expect(await basePrisma.contactTag.count({ where: { teamId: { in: TIMES } } })).toBe(0);
  });
});

describe("dois times — conversas", () => {
  it("startConversationWithContact recusa contato do time B", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(startConversationWithContact(a.conta.id, b.contato.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
  });

  it("startConversationWithContact recusa conta do time B (não envia pelo número alheio)", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(startConversationWithContact(b.conta.id, a.contato.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
    expect(await basePrisma.conversation.count({ where: { teamId: TEAM_A, channelAccountId: b.conta.id } })).toBe(0);
  });

  it("startConversationWithNumber recusa conta do time B antes de cadastrar contato", async () => {
    const { b } = await criarDoisMundos();
    const antes = await basePrisma.contact.count({ where: { teamId: TEAM_A } });
    await emA(async () => {
      await expect(startConversationWithNumber(b.conta.id, "Novo", "11988887777")).rejects.toBeInstanceOf(
        OwnedNotFound,
      );
    });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(antes);
  });

  it("markRead recusa conversa do time B e não zera o contador dela", async () => {
    const { b } = await criarDoisMundos();
    await emA(async () => {
      await expect(markRead(b.conversa.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
    const conv = await basePrisma.conversation.findUniqueOrThrow({ where: { id: b.conversa.id } });
    expect(conv.unreadCount).toBe(3);
  });
});

describe("dois times — agenda, contatos e ligações", () => {
  it("createAppointment / updateAppointment recusam contato do time B", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(
        createAppointment({ titulo: "Reunião", inicio: new Date().toISOString(), contactId: b.contato.id }),
      ).rejects.toBeInstanceOf(OwnedNotFound);
      const ok = await createAppointment({ titulo: "Reunião", inicio: new Date().toISOString(), contactId: a.contato.id });
      await expect(updateAppointment(ok.id, { contactId: b.contato.id })).rejects.toBeInstanceOf(OwnedNotFound);
    });
    expect(await basePrisma.appointment.count({ where: { contactId: b.contato.id } })).toBe(0);
  });

  it("mergeContacts recusa duplicado do time B e não apaga nada dele", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(mergeContacts(a.contato.id, [b.contato.id])).rejects.toBeInstanceOf(OwnedNotFound);
    });
    expect(await basePrisma.contact.findUnique({ where: { id: b.contato.id } })).not.toBeNull();
  });

  it("removeMany com ids do time B não apaga nada do time B", async () => {
    const { b } = await criarDoisMundos();
    const r = await emA(() => removeMany([b.contato.id]));
    expect(r.deleted).toBe(0);
    expect(await basePrisma.contact.findUnique({ where: { id: b.contato.id } })).not.toBeNull();
  });

  it("createManualCall recusa contato do time B", async () => {
    const { b } = await criarDoisMundos();
    await emA(async () => {
      await expect(createManualCall({ phoneNumber: "11977776666", contactId: b.contato.id })).rejects.toBeInstanceOf(
        OwnedNotFound,
      );
    });
    expect(await basePrisma.call.count({ where: { contactId: b.contato.id } })).toBe(0);
  });

  it("createCall recusa conta do time B", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      await expect(
        createCall({
          contactId: a.contato.id,
          phoneNumber: "11977776666",
          direction: "outbound",
          provider: "manual",
          channelAccountId: b.conta.id,
        }),
      ).rejects.toBeInstanceOf(OwnedNotFound);
    });
  });

  it("finishManualCall recusa vincular negócio do time B", async () => {
    const { a, b } = await criarDoisMundos();
    await emA(async () => {
      const { callId } = await createManualCall({ phoneNumber: "11977776666", contactId: a.contato.id });
      await expect(finishManualCall(callId, { outcome: "answered", dealId: b.deal.id })).rejects.toBeInstanceOf(
        OwnedNotFound,
      );
    });
    expect(await basePrisma.activity.count({ where: { teamId: TEAM_A, dealId: b.deal.id } })).toBe(0);
  });
});

describe("dois times: linha de ligação, integração e identificador de canal (F1B-05)", () => {
  async function criarPecas() {
    const { a, b } = await criarDoisMundos();
    const de = async (teamId: string, contactId: string, sufixo: string) => ({
      integracao: await basePrisma.integration.create({ data: { teamId, tipo: "webhook" } }),
      linha: await basePrisma.linhaDeLigacao.create({
        data: { teamId, provedor: "teste_um", tipo: "ramal", contaExterna: "conta-assert-owned", idExterno: `ramal-${sufixo}` },
      }),
      identificador: await basePrisma.channelIdentifier.create({
        data: { teamId, contactId, canal: "whatsapp", valor: sufixo === "a" ? "+5511900010001" : "+5511900010002" },
      }),
    });
    return { a, b, pa: await de(TEAM_A, a.contato.id, "a"), pb: await de(TEAM_B, b.contato.id, "b") };
  }

  it("aceita os do time A e recusa os do time B, inexistentes e vazios", async () => {
    const { pa, pb } = await criarPecas();
    await emA(async () => {
      for (const [modelo, meu, alheio] of [
        ["linhaDeLigacao", pa.linha.id, pb.linha.id],
        ["integration", pa.integracao.id, pb.integracao.id],
        ["channelIdentifier", pa.identificador.id, pb.identificador.id],
      ] as const) {
        await expect(assertOwned(modelo, meu), modelo).resolves.toBeUndefined();
        await expect(assertOwned(modelo, alheio), modelo).rejects.toBeInstanceOf(OwnedNotFound);
        await expect(assertOwned(modelo, "00000000-0000-0000-0000-00000000dead"), modelo).rejects.toBeInstanceOf(OwnedNotFound);
        await expect(assertOwned(modelo, ""), modelo).rejects.toBeInstanceOf(OwnedNotFound);
        await expect(assertOwnedMany(modelo, [meu, alheio]), modelo).rejects.toBeInstanceOf(OwnedNotFound);
        await expect(assertOwnedIfPresent(modelo, null), modelo).resolves.toBeUndefined();
      }
    });
  });

  it("identificador: o membro não usa o número do contato do colega; o dono do contato e o administrador usam", async () => {
    const MEMBRO = "00000000-0000-0000-0000-0000f1b050c1";
    const COLEGA = "00000000-0000-0000-0000-0000f1b050c2";
    for (const [id, nome] of [
      [MEMBRO, "Membro"],
      [COLEGA, "Colega"],
    ] as const) {
      await basePrisma.user.upsert({
        where: { id },
        update: { teamId: TEAM_A },
        create: { id, teamId: TEAM_A, name: nome, email: `${id}@assert-owned-f1b05.teste.local`, role: "member" },
      });
    }
    const { a, pa } = await criarPecas();
    const doColega = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Do colega", ownerId: COLEGA } });
    const idDoColega = await basePrisma.channelIdentifier.create({ data: { teamId: TEAM_A, contactId: doColega.id, canal: "whatsapp", valor: "+5511900010003" } });
    await basePrisma.contact.update({ where: { id: a.contato.id }, data: { ownerId: MEMBRO } });

    const comoMembro = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn, { userId: MEMBRO, role: "member" });
    await comoMembro(async () => {
      await expect(assertOwned("channelIdentifier", pa.identificador.id)).resolves.toBeUndefined();
      await expect(assertOwned("channelIdentifier", idDoColega.id)).rejects.toBeInstanceOf(OwnedNotFound);
    });
    // Administrador e dono do time alcançam os dois.
    await emA(async () => {
      await expect(assertOwned("channelIdentifier", idDoColega.id)).resolves.toBeUndefined();
    });
  });
});
