import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000f1"];

/**
 * Testes do motor de fluxos.
 *
 * IMPORTANTE — a fila é mockada de propósito. O worker de produção consome a
 * fila `flow` no mesmo Redis; se um teste enfileirasse de verdade, o worker
 * pegaria o job e ENVIARIA WHATSAPP REAL. O mock também deixa os testes
 * determinísticos (sem depender de Redis no ambiente de CI).
 */
const scheduleStep = vi.fn();
vi.mock("./queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { findStartNode, enrollByTrigger, jitterDelayMs } = await import("./triggers");
const { executeNode } = await import("./executor");
const { activateFlow, enrollByWebhook } = await import("./service");
type SnapshotNode = Awaited<typeof import("./schema")>["snapshotNodeSchema"]["_output"];

const TEAM = "00000000-0000-0000-0000-0000000000f1";

beforeAll(async () => {
  await basePrisma.team.upsert({
    where: { id: TEAM },
    update: { name: "Team Flows (test)" },
    create: { id: TEAM, name: "Team Flows (test)" },
  });
});

beforeEach(async () => {
  scheduleStep.mockClear();
  await basePrisma.flowStepExecution.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.enrollment.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.flowNode.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.flow.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

async function criarContato(nome = "Fulano") {
  return basePrisma.contact.create({ data: { teamId: TEAM, nome } });
}

/** Cria fluxo ativo. `nodes` na ordem de criação (= createdAt). */
async function criarFluxo(nodes: Array<{ id: string; tipo: string; nextNodeId?: string | null; branches?: unknown }>) {
  const flow = await basePrisma.flow.create({
    data: { teamId: TEAM, nome: "Fluxo teste", triggerType: "contact_created", status: "active" },
  });
  for (const n of nodes) {
    await basePrisma.flowNode.create({
      data: {
        id: n.id,
        teamId: TEAM,
        flowId: flow.id,
        tipo: n.tipo as never,
        config: {} as never,
        nextNodeId: n.nextNodeId ?? null,
        branches: (n.branches ?? null) as never,
      },
    });
  }
  return flow;
}

// ---------------------------------------------------------------------------
describe("findStartNode — entrada pela topologia, não pela ordem de criação", () => {
  // Regressão do bug real: fluxo "digitando → mensagem" onde a MENSAGEM foi
  // criada primeiro. O motor começava nela e pulava o digitando ("mandava
  // direto"). Ver skill crmagro-motor §2.
  it("escolhe o nó que ninguém aponta, mesmo criado por último", () => {
    const snap = [
      { id: "msg", tipo: "send_message", nextNodeId: null },
      { id: "typ", tipo: "typing", nextNodeId: "msg" },
    ] as unknown as SnapshotNode[];
    const ordered = [{ id: "msg" }, { id: "typ" }]; // createdAt: msg primeiro
    expect(findStartNode(snap, ordered)?.id).toBe("typ");
  });

  it("fluxo linear começa no primeiro", () => {
    const snap = [
      { id: "A", tipo: "send_message", nextNodeId: "B" },
      { id: "B", tipo: "wait", nextNodeId: "C" },
      { id: "C", tipo: "send_message", nextNodeId: null },
    ] as unknown as SnapshotNode[];
    expect(findStartNode(snap, [{ id: "A" }, { id: "B" }, { id: "C" }])?.id).toBe("A");
  });

  it("ignora destinos de branch e default da condição", () => {
    const snap = [
      { id: "start", tipo: "send_message", nextNodeId: "cond" },
      { id: "cond", tipo: "condition", branches: { branches: [{ nextNodeId: "X" }], default: "Y" } },
      { id: "X", tipo: "send_message", nextNodeId: null },
      { id: "Y", tipo: "send_message", nextNodeId: null },
    ] as unknown as SnapshotNode[];
    // ordem de criação embaralhada de propósito
    const ordered = [{ id: "X" }, { id: "cond" }, { id: "start" }, { id: "Y" }];
    expect(findStartNode(snap, ordered)?.id).toBe("start");
  });

  it("ciclo sem entrada cai no primeiro por createdAt (não trava)", () => {
    const snap = [
      { id: "A", tipo: "wait", nextNodeId: "B" },
      { id: "B", tipo: "wait", nextNodeId: "A" },
    ] as unknown as SnapshotNode[];
    expect(findStartNode(snap, [{ id: "A" }, { id: "B" }])?.id).toBe("A");
  });
});

// ---------------------------------------------------------------------------
describe("enrollByTrigger — trava de reinscrição", () => {
  // Regressão do bug real: mesmo contato inscrito 2x no mesmo fluxo, recebendo
  // a mensagem duas vezes. Com gatilho message_received isso vira amplificação
  // (resposta → inscreve → envia → resposta...). Ver skill crmagro-motor.
  it("não reinscreve contato que já está percorrendo o fluxo", async () => {
    const contato = await criarContato();
    await criarFluxo([{ id: "n1", tipo: "send_message", nextNodeId: null }]);

    await runWithTeam(TEAM, async () => {
      await enrollByTrigger("contact_created", { contactId: contato.id });
      await enrollByTrigger("contact_created", { contactId: contato.id });
    });

    const total = await basePrisma.enrollment.count({ where: { contactId: contato.id } });
    expect(total).toBe(1);
    expect(scheduleStep).toHaveBeenCalledTimes(1);
  });

  it("permite nova inscrição depois que a anterior terminou", async () => {
    const contato = await criarContato();
    await criarFluxo([{ id: "n1", tipo: "send_message", nextNodeId: null }]);

    await runWithTeam(TEAM, async () => {
      await enrollByTrigger("contact_created", { contactId: contato.id });
    });
    await basePrisma.enrollment.updateMany({ where: { contactId: contato.id }, data: { status: "done" } });
    await runWithTeam(TEAM, async () => {
      await enrollByTrigger("contact_created", { contactId: contato.id });
    });

    expect(await basePrisma.enrollment.count({ where: { contactId: contato.id } })).toBe(2);
  });

  it("inscreve no nó de ENTRADA do grafo, não no primeiro criado", async () => {
    const contato = await criarContato();
    await criarFluxo([
      { id: "msg", tipo: "send_message", nextNodeId: null },
      { id: "typ", tipo: "typing", nextNodeId: "msg" },
    ]);

    await runWithTeam(TEAM, async () => {
      await enrollByTrigger("contact_created", { contactId: contato.id });
    });

    const enr = await basePrisma.enrollment.findFirstOrThrow({ where: { contactId: contato.id } });
    expect(enr.currentNodeId).toBe("typ");
    // 4º arg = delayMs (undefined sem jitter).
    expect(scheduleStep).toHaveBeenCalledWith(enr.id, "typ", 1, undefined);
  });
});

// ---------------------------------------------------------------------------
describe("executeNode — nó wait", () => {
  const ctx = {
    id: "e1",
    teamId: TEAM,
    contactId: "c1",
    lastOutboundAt: null,
    contact: { id: "c1", nome: "Teste", tags: [], ownerId: null },
  };

  it("espera fixa converte a unidade corretamente", async () => {
    const r = await executeNode(ctx, {
      id: "w",
      tipo: "wait",
      config: { duration: 30, unit: "sec" },
      nextNodeId: "prox",
    } as never);
    expect(r.delayMs).toBe(30_000);
    expect(r.nextNodeId).toBe("prox");
  });

  it("2 horas = 7.200.000 ms", async () => {
    const r = await executeNode(ctx, {
      id: "w",
      tipo: "wait",
      config: { duration: 2, unit: "hour" },
      nextNodeId: null,
    } as never);
    expect(r.delayMs).toBe(7_200_000);
  });

  it("modo intercalar sorteia dentro do intervalo e cobre os extremos", async () => {
    const vistos = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const r = await executeNode(ctx, {
        id: "w",
        tipo: "wait",
        config: { duration: 6, unit: "sec", durationMax: 15 },
        nextNodeId: null,
      } as never);
      expect(r.delayMs).toBeGreaterThanOrEqual(6_000);
      expect(r.delayMs).toBeLessThanOrEqual(15_000);
      vistos.add(r.delayMs! / 1000);
    }
    // controle de ritmo: se não variar, o intervalo fixo volta a ser padrão detectável
    expect(vistos.size).toBeGreaterThan(5);
    expect(vistos.has(6)).toBe(true);
    expect(vistos.has(15)).toBe(true);
  });

  it("durationMax <= duration é tratado como espera fixa", async () => {
    const r = await executeNode(ctx, {
      id: "w",
      tipo: "wait",
      config: { duration: 10, unit: "sec", durationMax: 10 },
      nextNodeId: null,
    } as never);
    expect(r.delayMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
describe("executeNode — condição 'respondeu?' e a janela de espera", () => {
  // Regressão do bug real: a condição era medida 1s após o envio, sempre dava
  // "não respondeu" e o fluxo encerrava no 'senão'. Ver skill crmagro-motor §3.
  const nodeCondicao = (janelaMin?: number) =>
    ({
      id: "cond",
      tipo: "condition",
      branches: {
        branches: [
          {
            id: "b1",
            label: "Respondeu",
            condition: janelaMin === undefined ? { type: "responded" } : { type: "responded", janelaMin },
            nextNodeId: "MSG2",
          },
        ],
        default: null,
      },
    }) as never;

  async function ctxCom(lastOutboundAt: Date | null, contactId: string) {
    return { id: "e1", teamId: TEAM, contactId, lastOutboundAt, contact: { id: contactId, nome: "Teste", tags: [], ownerId: null } };
  }

  it("sem resposta e janela aberta: espera por EVENTO — um job só no fim da janela (item 1.1)", async () => {
    const c = await criarContato();
    const agora = new Date();
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(agora, c.id), nodeCondicao(60)));
    expect(r.nextNodeId).toBe("cond"); // volta pra si mesma
    // Janela de 60 min = 1 job (timeout no fim da janela), não 120 re-checagens de 30 s.
    expect(r.delayMs).toBeGreaterThan(59 * 60_000);
    expect(r.delayMs).toBeLessThanOrEqual(60 * 60_000);
    expect(r.aguardandoResposta?.ate).toBeInstanceOf(Date);
  });

  it("janela longa (3 dias): re-checa só a cada 60 min como rede de segurança", async () => {
    const c = await criarContato();
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(new Date(), c.id), nodeCondicao(3 * 24 * 60)));
    expect(r.delayMs).toBe(60 * 60_000);
    expect(r.aguardandoResposta!.ate.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
  });

  it("canal do nó é respeitado: resposta por e-mail não conta para 'respondeu no WhatsApp?'", async () => {
    const c = await criarContato();
    const envio = new Date(Date.now() - 60_000);
    await basePrisma.activity.create({
      data: { teamId: TEAM, contactId: c.id, tipo: "email", direcao: "in", conteudo: "respondi por e-mail" },
    });
    const soWhats = {
      id: "cond",
      tipo: "condition",
      branches: {
        branches: [{ id: "b1", label: "R", condition: { type: "responded", janelaMin: 60, canal: "whatsapp" }, nextNodeId: "MSG2" }],
        default: null,
      },
    } as never;
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(envio, c.id), soWhats));
    expect(r.nextNodeId).toBe("cond"); // continua esperando o WhatsApp
  });

  it("respondeu dentro da janela: segue o ramo", async () => {
    const c = await criarContato();
    const envio = new Date(Date.now() - 60_000);
    await basePrisma.activity.create({
      data: { teamId: TEAM, contactId: c.id, tipo: "whatsapp", direcao: "in", conteudo: "oi" },
    });
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(envio, c.id), nodeCondicao(60)));
    expect(r.nextNodeId).toBe("MSG2");
  });

  it("janela expirada sem resposta: cai no 'senão'", async () => {
    const c = await criarContato();
    const envioAntigo = new Date(Date.now() - 61 * 60_000); // 61 min atrás
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(envioAntigo, c.id), nodeCondicao(60)));
    expect(r.nextNodeId).toBeNull();
  });

  it("fluxo antigo sem janelaMin assume o padrão (não encerra na hora)", async () => {
    const c = await criarContato();
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(new Date(), c.id), nodeCondicao()));
    // com o padrão de 60min, ainda há janela → reagenda em vez de encerrar
    expect(r.nextNodeId).toBe("cond");
  });

  it("sem envio anterior não há janela — cai no 'senão'", async () => {
    const c = await criarContato();
    const r = await runWithTeam(TEAM, async () => executeNode(await ctxCom(null, c.id), nodeCondicao(60)));
    expect(r.nextNodeId).toBeNull();
  });
});

describe("gatilho de tag + trava de ativação", () => {
  async function criarFluxoTag(triggerConfig: unknown) {
    const flow = await basePrisma.flow.create({
      data: { teamId: TEAM, nome: "Fluxo tag", triggerType: "tag_added", status: "active", triggerConfig: triggerConfig as never },
    });
    await basePrisma.flowNode.create({
      data: { id: "n1", teamId: TEAM, flowId: flow.id, tipo: "send_message" as never, config: { text: "oi" } as never, nextNodeId: null },
    });
    return flow;
  }

  it("tag_added só inscreve quando a tag do gatilho bate", async () => {
    const flow = await criarFluxoTag({ tagId: "tag-A" });
    const c = await criarContato();
    await runWithTeam(TEAM, async () => {
      scheduleStep.mockClear();
      await enrollByTrigger("tag_added", { contactId: c.id, tagId: "tag-B" }); // não bate
      expect(scheduleStep).not.toHaveBeenCalled();
      await enrollByTrigger("tag_added", { contactId: c.id, tagId: "tag-A" }); // bate
      expect(scheduleStep).toHaveBeenCalledTimes(1);
    });
    void flow;
  });

  it("tag_added sem tag configurada nunca dispara", async () => {
    await criarFluxoTag({});
    const c = await criarContato();
    await runWithTeam(TEAM, async () => {
      scheduleStep.mockClear();
      await enrollByTrigger("tag_added", { contactId: c.id, tagId: "qualquer" });
      expect(scheduleStep).not.toHaveBeenCalled();
    });
  });

  it("activateFlow bloqueia gatilho de tag sem tag e libera com tag", async () => {
    const semTag = await basePrisma.flow.create({
      data: { teamId: TEAM, nome: "sem tag", triggerType: "tag_added", status: "draft", triggerConfig: {} as never },
    });
    await basePrisma.flowNode.create({
      data: { id: "s1", teamId: TEAM, flowId: semTag.id, tipo: "send_message" as never, config: {} as never, nextNodeId: null },
    });
    await expect(runWithTeam(TEAM, async () => activateFlow(semTag.id))).rejects.toThrow(/tag/i);

    await basePrisma.flow.update({ where: { id: semTag.id }, data: { triggerConfig: { tagId: "t1" } as never } });
    const ativado = await runWithTeam(TEAM, async () => activateFlow(semTag.id));
    expect(ativado.status).toBe("active");
  });
});

describe("findStartNode — início explícito (startNodeId do gatilho)", () => {
  it("início explícito vence a topologia quando o nó existe", () => {
    const snap = [
      { id: "A", tipo: "send_message", nextNodeId: "B" },
      { id: "B", tipo: "wait", nextNodeId: null },
    ] as unknown as SnapshotNode[];
    // topologia diria "A"; explícito manda em "B"
    expect(findStartNode(snap, [{ id: "A" }, { id: "B" }], "B")?.id).toBe("B");
  });

  it("início explícito inexistente cai na topologia", () => {
    const snap = [
      { id: "A", tipo: "send_message", nextNodeId: "B" },
      { id: "B", tipo: "wait", nextNodeId: null },
    ] as unknown as SnapshotNode[];
    expect(findStartNode(snap, [{ id: "A" }, { id: "B" }], "removido")?.id).toBe("A");
  });
});

describe("jitter inicial por inscrição", () => {
  it("jitterDelayMs: 0 sem config; dentro do intervalo com min/max", () => {
    expect(jitterDelayMs(null)).toBe(0);
    expect(jitterDelayMs({})).toBe(0);
    expect(jitterDelayMs({ jitterMin: 5, jitterMax: 5 })).toBe(5 * 60_000);
    for (let i = 0; i < 20; i++) {
      const ms = jitterDelayMs({ jitterMin: 6, jitterMax: 15 });
      expect(ms).toBeGreaterThanOrEqual(6 * 60_000);
      expect(ms).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  it("enrollByTrigger com jitter cria enrollment 'waiting' com nextRunAt e agenda com delay", async () => {
    const contato = await criarContato();
    const flow = await basePrisma.flow.create({
      data: { teamId: TEAM, nome: "Jitter", triggerType: "contact_created", status: "active", triggerConfig: { jitterMin: 10, jitterMax: 10 } as never },
    });
    await basePrisma.flowNode.create({
      data: { id: "j1", teamId: TEAM, flowId: flow.id, tipo: "send_message" as never, config: {} as never, nextNodeId: null },
    });
    await runWithTeam(TEAM, async () => enrollByTrigger("contact_created", { contactId: contato.id }));
    const enr = await basePrisma.enrollment.findFirstOrThrow({ where: { contactId: contato.id } });
    expect(enr.status).toBe("waiting");
    expect(enr.nextRunAt).toBeTruthy();
    // scheduleStep chamado com delay ~10min
    const call = scheduleStep.mock.calls.at(-1);
    expect(call?.[3]).toBe(10 * 60_000);
  });
});

describe("gatilho de webhook (enrollByWebhook)", () => {
  const TOKEN_WH = "tok123tok123tok123tok123tok123tok123";
  it("token válido cria/acha o contato e inscreve no fluxo; token inválido não faz nada", async () => {
    const flow = await basePrisma.flow.create({
      // Token no formato do servidor (coluna única — item 0.6).
      data: { teamId: TEAM, nome: "Webhook", triggerType: "webhook", status: "active", webhookToken: TOKEN_WH, triggerConfig: { webhookToken: TOKEN_WH } as never },
    });
    await basePrisma.flowNode.create({
      data: { id: "w1", teamId: TEAM, flowId: flow.id, tipo: "send_message" as never, config: {} as never, nextNodeId: null },
    });

    const ruim = await enrollByWebhook("token-errado", { telefone: "11999998888" });
    expect(ruim.ok).toBe(false);

    const ok = await enrollByWebhook(TOKEN_WH, { nome: "Lead X", telefone: "11999998888" });
    expect(ok.ok).toBe(true);
    expect(ok.contactId).toBeTruthy();
    const enr = await basePrisma.enrollment.findFirst({ where: { flowId: flow.id, contactId: ok.contactId! } });
    expect(enr).toBeTruthy();

    // segunda chamada com o mesmo telefone NÃO duplica o contato
    const ok2 = await enrollByWebhook(TOKEN_WH, { telefone: "11999998888" });
    expect(ok2.contactId).toBe(ok.contactId);
  });
});

describe("executeNode — teste A/B (ab_split)", () => {
  const nodeAB = {
    id: "ab",
    tipo: "ab_split",
    branches: { variants: [
      { id: "va", label: "A", weight: 70, nextNodeId: "na" },
      { id: "vb", label: "B", weight: 30, nextNodeId: "nb" },
    ] },
  } as never;

  it("é DETERMINÍSTICO por enrollment+node (mesmo contato → mesma variante)", async () => {
    const ctx = { id: "enr-fixo", teamId: TEAM, contactId: "c1", lastOutboundAt: null, contact: { id: "c1", nome: "Teste", tags: [], ownerId: null } };
    const r1 = await executeNode(ctx, nodeAB);
    const r2 = await executeNode(ctx, nodeAB);
    const r3 = await executeNode(ctx, nodeAB);
    expect(r1.nextNodeId).toBe(r2.nextNodeId);
    expect(r2.nextNodeId).toBe(r3.nextNodeId);
    expect(["na", "nb"]).toContain(r1.nextNodeId);
  });

  it("distribui ~conforme os pesos entre muitos enrollments", async () => {
    let a = 0, b = 0;
    for (let i = 0; i < 400; i++) {
      const ctx = { id: `enr-${i}`, teamId: TEAM, contactId: "c1", lastOutboundAt: null, contact: { id: "c1", nome: "Teste", tags: [], ownerId: null } };
      const r = await executeNode(ctx, nodeAB);
      if (r.nextNodeId === "na") a++; else if (r.nextNodeId === "nb") b++;
    }
    expect(a + b).toBe(400);
    // 70/30 esperado; tolerância ampla
    expect(a / 400).toBeGreaterThan(0.55);
    expect(a / 400).toBeLessThan(0.85);
  });

  it("peso total 0 termina o fluxo", async () => {
    const ctx = { id: "e0", teamId: TEAM, contactId: "c1", lastOutboundAt: null, contact: { id: "c1", nome: "Teste", tags: [], ownerId: null } };
    const r = await executeNode(ctx, { id: "ab0", tipo: "ab_split", branches: { variants: [{ id: "x", label: "X", weight: 0, nextNodeId: "nx" }] } } as never);
    expect(r.nextNodeId).toBeNull();
  });
});
