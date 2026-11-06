import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * FlowVersion (item 2.7, DP-14): o grafo congelado mora uma vez por versão,
 * deduplicado por hash; a inscrição nova só aponta para ela e a antiga continua
 * lendo o próprio flowSnapshot. Fila mockada.
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

const { createFlow, activateFlow, updateFlow, enroll, enrollmentNodes, redirectEnrollment, completeManualCall, listFlowRuns, listReviewEnrollments } =
  await import("./service");
const { enrollByTrigger, enrollManyByTrigger } = await import("./triggers");
const { hashDoSnapshot, snapshotDaInscricao, _limparCacheDeVersoes } = await import("./versao");
const { lerNoDoSnapshot } = await import("./snapshot");

const TEAM = "00000000-0000-0000-0000-0000000002ad";
const OUTRO = "00000000-0000-0000-0000-0000000002ae";
const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Versão (test)"], [OUTRO, "Team Versão B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

beforeEach(async () => {
  scheduleStep.mockClear();
  _limparCacheDeVersoes();
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.flowStepExecution.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.flowVersion.deleteMany({ where: w });
    await basePrisma.flowNode.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
  }
});

/** Grafo: mensagem → ligação manual → espera. */
function grafo(texto: string, prefixo: string) {
  const id = (x: string) => `${prefixo}-${x}`;
  return [
    { id: id("msg"), tipo: "send_message" as const, config: { text: texto }, nextNodeId: id("ligar") },
    { id: id("ligar"), tipo: "manual_call" as const, config: { roteiro: "apresentar" }, nextNodeId: id("espera") },
    { id: id("espera"), tipo: "wait" as const, config: { duration: 1, unit: "day" as const }, nextNodeId: null },
  ];
}

async function fluxoAtivo(teamId: string, texto = "Olá, {{nome}}!", triggerType: "manual" | "contact_created" = "manual") {
  const prefixo = `n${seq++}-${sufixo}`;
  return runWithTeam(teamId, async () => {
    const f = await createFlow({ nome: `Versão ${prefixo}`, triggerType, nodes: grafo(texto, prefixo) });
    await activateFlow(f.id);
    return { flow: f, prefixo, no: (x: string) => `${prefixo}-${x}` };
  });
}

const contato = (teamId: string) => basePrisma.contact.create({ data: { teamId, nome: `C${seq++}` } });
const inscricao = (id: string) => basePrisma.enrollment.findUniqueOrThrow({ where: { id } });
const versoesDo = (flowId: string) => basePrisma.flowVersion.count({ where: { flowId } });

/** O que o worker faz a cada passo: resolve o grafo e lê SÓ o nó corrente. */
async function lerComoOWorker(enrollmentId: string, nodeId: string) {
  const enr = await inscricao(enrollmentId);
  const snapshot = await runAsSystem(enr.teamId, () => snapshotDaInscricao(enr));
  return lerNoDoSnapshot(snapshot, nodeId, enr.snapshotVersion);
}

async function inscrever(teamId: string, flowId: string) {
  const c = await contato(teamId);
  const e = await runWithTeam(teamId, () => enroll(c.id, flowId));
  return inscricao(e.id);
}

describe("mesmo grafo = mesma versão", () => {
  it("inscrições manual, por gatilho e em lote apontam para UMA versão, sem copiar o grafo", async () => {
    const { flow } = await fluxoAtivo(TEAM, "Oi!", "contact_created");
    const a = await inscrever(TEAM, flow.id);
    const b = await inscrever(TEAM, flow.id);
    const c = await contato(TEAM);
    await runWithTeam(TEAM, () => enrollByTrigger("contact_created", { contactId: c.id }));
    const viaGatilho = await basePrisma.enrollment.findFirstOrThrow({ where: { contactId: c.id } });
    const emLote = await Promise.all([contato(TEAM), contato(TEAM)]);
    await runWithTeam(TEAM, () => enrollManyByTrigger("contact_created", emLote.map((x) => x.id)));
    const viaLote = await basePrisma.enrollment.findMany({ where: { contactId: { in: emLote.map((x) => x.id) } } });

    expect(a.flowVersionId).toBeTruthy();
    expect(viaLote).toHaveLength(2);
    for (const e of [a, b, viaGatilho, ...viaLote]) {
      expect(e.flowVersionId).toBe(a.flowVersionId);
      expect(e.flowSnapshot).toBeNull();
    }
    expect(await versoesDo(flow.id)).toBe(1);
  });

  it("inscrições simultâneas num grafo novo não duplicam a versão", async () => {
    const { flow } = await fluxoAtivo(TEAM);
    const cs = await Promise.all([contato(TEAM), contato(TEAM), contato(TEAM)]);
    const es = await Promise.all(cs.map((c) => runWithTeam(TEAM, () => enroll(c.id, flow.id))));
    const versoes = new Set((await Promise.all(es.map((e) => inscricao(e.id)))).map((e) => e.flowVersionId));
    expect(versoes.size).toBe(1);
    expect(await versoesDo(flow.id)).toBe(1);
  });

  it("hash: ordem dos nós e das chaves não importa; o formato importa", () => {
    const g = grafo("x", "h");
    // Mesmos nós em outra ordem, e o do meio com as chaves em outra ordem.
    const meio = g[1]!;
    const embaralhado = [g[2]!, g[0]!, { nextNodeId: meio.nextNodeId, config: meio.config, tipo: meio.tipo, id: meio.id }] as typeof g;
    expect(hashDoSnapshot(embaralhado)).toBe(hashDoSnapshot(g));
    expect(hashDoSnapshot(grafo("y", "h"))).not.toBe(hashDoSnapshot(g));
    expect(hashDoSnapshot(g, 2)).not.toBe(hashDoSnapshot(g, 1));
  });
});

describe("editar o fluxo = versão nova, sem afetar quem está no meio", () => {
  it("quem entrou antes segue com o texto antigo; voltar ao grafo antigo reaproveita a versão", async () => {
    const { flow, prefixo, no } = await fluxoAtivo(TEAM, "Texto v1");
    const antes = await inscrever(TEAM, flow.id);

    await runWithTeam(TEAM, () => updateFlow(flow.id, { nodes: grafo("Texto v2", prefixo) }));
    const depois = await inscrever(TEAM, flow.id);
    expect(depois.flowVersionId).not.toBe(antes.flowVersionId);
    expect(await versoesDo(flow.id)).toBe(2);

    const lidoAntes = await lerComoOWorker(antes.id, no("msg"));
    const lidoDepois = await lerComoOWorker(depois.id, no("msg"));
    expect(lidoAntes.ok && lidoAntes.node.tipo === "send_message" && lidoAntes.node.config.text).toBe("Texto v1");
    expect(lidoDepois.ok && lidoDepois.node.tipo === "send_message" && lidoDepois.node.config.text).toBe("Texto v2");

    await runWithTeam(TEAM, () => updateFlow(flow.id, { nodes: grafo("Texto v1", prefixo) }));
    const deNovo = await inscrever(TEAM, flow.id);
    expect(deNovo.flowVersionId).toBe(antes.flowVersionId);
    expect(await versoesDo(flow.id)).toBe(2);
  });
});

describe("inscrição antiga (flowSnapshot) e nova (flowVersionId) rodam", () => {
  async function antigaENova() {
    const { flow, prefixo, no } = await fluxoAtivo(TEAM, "Olá");
    const nova = await inscrever(TEAM, flow.id);
    // Antiga: como era gravada antes deste item (grafo copiado, sem versão).
    const c = await contato(TEAM);
    const antiga = await basePrisma.enrollment.create({
      data: {
        teamId: TEAM,
        flowId: flow.id,
        contactId: c.id,
        currentNodeId: no("msg"),
        currentRound: 1,
        status: "active",
        nextRunAt: new Date(),
        flowSnapshot: grafo("Olá (antiga)", prefixo) as unknown as Prisma.InputJsonValue,
      },
    });
    return { flow, no, nova, antiga };
  }

  it("o worker lê o nó corrente das duas", async () => {
    const { no, nova, antiga } = await antigaENova();
    const lNova = await lerComoOWorker(nova.id, no("msg"));
    const lAntiga = await lerComoOWorker(antiga.id, no("msg"));
    expect(lNova.ok && lNova.node.tipo === "send_message" && lNova.node.config.text).toBe("Olá");
    expect(lAntiga.ok && lAntiga.node.tipo === "send_message" && lAntiga.node.config.text).toBe("Olá (antiga)");
    // Nó que não existe no grafo da inscrição continua falha visível.
    expect(await lerComoOWorker(nova.id, "nao-existe")).toMatchObject({ ok: false, motivo: "destino_inexistente" });
  });

  it("revisão, destino, ligação feita e log funcionam nas duas", async () => {
    const { flow, no, nova, antiga } = await antigaENova();
    for (const e of [nova, antiga]) {
      // Segura as duas na ligação manual, como o executor faz.
      await basePrisma.enrollment.update({ where: { id: e.id }, data: { status: "waiting", nextRunAt: null, currentNodeId: no("ligar") } });
      await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: e.id, nodeId: no("msg"), round: 1, status: "done" } });
    }

    const revisao = await runWithTeam(TEAM, () => listReviewEnrollments(flow.id));
    expect(revisao.map((r) => [r.id, r.currentNodeType, r.motivo]).sort()).toEqual(
      [[nova.id, "manual_call", "ligação pendente"], [antiga.id, "manual_call", "ligação pendente"]].sort(),
    );

    const runs = await runWithTeam(TEAM, () => listFlowRuns(flow.id));
    for (const e of [nova, antiga]) expect(runs.find((r) => r.id === e.id)?.steps[0]?.nodeType).toBe("send_message");

    for (const e of [nova, antiga]) {
      expect((await runWithTeam(TEAM, () => enrollmentNodes(e.id))).map((n) => n.tipo)).toEqual(["send_message", "manual_call", "wait"]);
    }

    await runWithTeam(TEAM, () => completeManualCall(nova.id, { resumo: "ok" }));
    expect(await inscricao(nova.id)).toMatchObject({ status: "active", currentNodeId: no("espera") });

    await runWithTeam(TEAM, () => redirectEnrollment(antiga.id, no("espera")));
    expect(await inscricao(antiga.id)).toMatchObject({ status: "active", currentNodeId: no("espera") });
  });
});

describe("dois times", () => {
  it("versão de um time nunca é lida por outro, nem pelo cache", async () => {
    const { flow } = await fluxoAtivo(TEAM, "Segredo do time A");
    const a = await inscrever(TEAM, flow.id);
    // Aquece o cache no contexto do time A.
    expect(await runWithTeam(TEAM, () => snapshotDaInscricao(a))).not.toBeNull();
    // O time B, com o id da versão de A em mãos, não recebe nada.
    expect(await runWithTeam(OUTRO, () => snapshotDaInscricao(a))).toBeNull();

    // Cada time tem a sua versão, mesmo com o mesmo texto.
    const { flow: flowB } = await fluxoAtivo(OUTRO, "Segredo do time A");
    const b = await inscrever(OUTRO, flowB.id);
    expect(b.flowVersionId).not.toBe(a.flowVersionId);
    expect(await basePrisma.flowVersion.count({ where: { teamId: OUTRO } })).toBe(1);
  });
});

describe("cache e integridade", () => {
  it("a versão é lida do banco uma vez e depois vem do cache", async () => {
    const { flow, no } = await fluxoAtivo(TEAM, "Original");
    const e = await inscrever(TEAM, flow.id);
    expect((await lerComoOWorker(e.id, no("msg"))).ok).toBe(true);
    // Versão é imutável; alterá-la por fora só serve para provar que o 2º passo não relê o banco.
    await basePrisma.flowVersion.update({ where: { id: e.flowVersionId! }, data: { snapshot: [] } });
    expect((await lerComoOWorker(e.id, no("msg"))).ok).toBe(true);
    _limparCacheDeVersoes();
    expect(await lerComoOWorker(e.id, no("msg"))).toMatchObject({ ok: false, motivo: "destino_inexistente" });
  });

  it("apagar o fluxo leva versões e inscrições juntas; apagar só a versão em uso é recusado", async () => {
    const { flow } = await fluxoAtivo(TEAM);
    const e = await inscrever(TEAM, flow.id);
    await expect(basePrisma.flowVersion.delete({ where: { id: e.flowVersionId! } })).rejects.toThrow();
    await basePrisma.flow.delete({ where: { id: flow.id } });
    expect(await basePrisma.flowVersion.count({ where: { flowId: flow.id } })).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { id: e.id } })).toBe(0);
  });
});
