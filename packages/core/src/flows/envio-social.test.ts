import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, encryptCredentials, runWithTeam as runWithTeamDb } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Envio social seguro (item 1.8 — INT-07/MF-11, INT-08, INT-09, MF-10). A fila
 * BullMQ, a extensão e o Playwright são MOCKADOS: nenhum DM sai de verdade.
 */
const fila = vi.hoisted(() => ({
  scheduleStep: vi.fn(async (..._a: unknown[]) => {}),
  enfileirados: [] as Array<Record<string, unknown>>,
  estadoSocial: null as string | null,
}));
vi.mock("./queue", () => ({
  scheduleStep: (...a: unknown[]) => fila.scheduleStep(...a),
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));
vi.mock("./fila-social", () => ({
  SOCIAL_QUEUE: "social",
  socialJobId: (e: string, n: string, r: number) => `social_${e}_${n}_${r}`,
  enfileirarEnvioSocial: async (j: Record<string, unknown>) => void fila.enfileirados.push(j),
  estadoDoEnvioSocial: async () => fila.estadoSocial,
}));

const { entregarEnvioSocial, processarEnvioSocial, enviarDmSocial, MARCA_ENVIO_SOCIAL } = await import("./envio-social");
const { varrerInscricoesOrfas } = await import("./avanco");
const { executeNode } = await import("./executor");
const { redisEstado } = await import("../shared/redis-cache");
const { consumeSendQuota } = await import("../channels-limit/service");
const { ChannelSendFailed, SessaoSocialInvalida } = await import("@crmagro/channels");
type EnvioSocialJob = import("./fila-social").EnvioSocialJob;

const TEAM = "00000000-0000-0000-0000-0000000000cb";
const OUTRO = "00000000-0000-0000-0000-0000000000cc";
const sufixo = Math.random().toString(36).slice(2, 8);
let seq = 0;
const uid = (p: string) => `${p}-${sufixo}-${seq++}`;

let contaId = "";
let contatoId = "";
let flowId = "";
let enrId = "";
const NODE = "dm";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Social (test)" } });
  await basePrisma.team.upsert({ where: { id: OUTRO }, update: {}, create: { id: OUTRO, name: "Team Social B (test)" } });
});

beforeEach(async () => {
  fila.scheduleStep.mockClear();
  fila.enfileirados.length = 0;
  fila.estadoSocial = null;
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.flowStepExecution.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.channelAccountUsage.deleteMany({ where: w });
    await basePrisma.channelIdentifier.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
    await basePrisma.channelAccount.deleteMany({ where: w });
  }
  const conta = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "instagram",
      label: "@vendedora",
      provider: "instagram_browser",
      status: "connected",
      credentials: encryptCredentials({ cookie: "x", username: "vendedora" }) as never,
    },
  });
  contaId = conta.id;
  await redisEstado().del(`social:trava:${contaId}`);
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = c.id;
  await redisEstado().del(`flow:contact:${c.id}:sends`);
  const snapshot = [
    { id: NODE, tipo: "send_social", config: { canal: "instagram", template: "Oi {nome}", onNoHandle: "skip", aiPersonalize: false }, nextNodeId: "fim" },
    { id: "fim", tipo: "add_tag", config: { tag: "dm" }, nextNodeId: null },
  ];
  const flow = await basePrisma.flow.create({ data: { teamId: TEAM, nome: uid("F"), triggerType: "manual", status: "active" } });
  flowId = flow.id;
  const e = await basePrisma.enrollment.create({
    data: {
      teamId: TEAM,
      flowId,
      contactId: c.id,
      currentNodeId: NODE,
      currentRound: 1,
      status: "active",
      nextRunAt: new Date(),
      flowSnapshot: snapshot as never,
    },
  });
  enrId = e.id;
  await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: e.id, nodeId: NODE, round: 1, status: "running" } });
});

/** Como o handler deixa a inscrição: esperando o DM na fila `social`. */
async function entregue(agora = new Date()) {
  await runWithTeam(TEAM, () =>
    entregarEnvioSocial({
      enrollmentId: enrId,
      nodeId: NODE,
      round: 1,
      teamId: TEAM,
      contactId: contatoId,
      social: { accountId: contaId, network: "instagram", to: "@lead_certo", text: "Oi Lead" },
      agora,
    }),
  );
  return fila.enfileirados.at(-1) as unknown as EnvioSocialJob;
}

const usoDoDia = async () => (await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: contaId } }))?.sent ?? 0;
const passo = () => basePrisma.flowStepExecution.findFirstOrThrow({ where: { enrollmentId: enrId, nodeId: NODE, round: 1 } });
const inscricao = () => basePrisma.enrollment.findUniqueOrThrow({ where: { id: enrId } });
/** A cota que o executor consumiu antes de entregar o DM. */
const consumirCota = () => runWithTeam(TEAM, () => consumeSendQuota(contaId));

describe("DM sai da fila flow para a fila social", () => {
  it("o handler entrega o DM e a inscrição ESPERA no passo (waitingFor=social), com o texto já pronto", async () => {
    const job = await entregue();
    expect(job).toMatchObject({ enrollmentId: enrId, nodeId: NODE, round: 1, accountId: contaId, text: "Oi Lead" });
    expect(await inscricao()).toMatchObject({ status: "waiting", waitingFor: MARCA_ENVIO_SOCIAL, currentNodeId: NODE, currentRound: 1 });
  });

  it("enviou e confirmou → marca 'enviado', passo done e a inscrição segue para o próximo nó", async () => {
    const job = await entregue();
    const enviar = vi.fn(async () => ({ providerMessageId: "relay-1" }));
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("enviado");
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(await passo()).toMatchObject({ status: "done" });
    expect(await inscricao()).toMatchObject({ currentNodeId: "fim", waitingFor: null, status: "active" });
    expect(fila.scheduleStep).toHaveBeenCalledWith(enrId, "fim", 1, undefined);
  });

  it("não saiu (retryable) → devolve a cota e repete o MESMO nó com backoff", async () => {
    await consumirCota();
    const job = await entregue();
    const enviar = vi.fn(async () => {
      throw new ChannelSendFailed("extensão: wrong_account", "not_sent", true);
    });
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("reagendado");
    expect(await usoDoDia()).toBe(0);
    expect(await inscricao()).toMatchObject({ status: "waiting", currentNodeId: NODE, currentRound: 2 });
  });

  it("resultado INCERTO → segura para revisão, sem devolver cota e sem reenviar", async () => {
    await consumirCota();
    const job = await entregue();
    const enviar = vi.fn(async () => {
      throw new ChannelSendFailed("extensão pegou o DM e não respondeu", "unknown", false);
    });
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("segurado");
    expect(await usoDoDia()).toBe(1);
    expect(await inscricao()).toMatchObject({ status: "waiting", nextRunAt: null, currentNodeId: NODE });
  });

  it("retry do job depois da marca 'enviando' NÃO reenvia: segura", async () => {
    const job = await entregue();
    await basePrisma.flowStepExecution.updateMany({ where: { enrollmentId: enrId }, data: { result: { fase: "enviando" } } });
    const enviar = vi.fn(async () => ({ providerMessageId: "x" }));
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("segurado");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("fluxo PAUSADO enquanto o DM esperava → não envia, devolve a cota e segura com a marca da pausa", async () => {
    await consumirCota();
    const job = await entregue();
    await basePrisma.flow.update({ where: { id: flowId }, data: { status: "paused" } });
    const enviar = vi.fn(async () => ({ providerMessageId: "x" }));
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("fora_do_ar");
    expect(enviar).not.toHaveBeenCalled();
    expect(await usoDoDia()).toBe(0);
    expect((await inscricao()).waitingFor).toBe("fluxo_pausado");
  });

  it("inscrição encerrada ('parar tudo') → DM descartado, passo pulado", async () => {
    const job = await entregue();
    await basePrisma.enrollment.update({ where: { id: enrId }, data: { status: "done" } });
    const enviar = vi.fn(async () => ({ providerMessageId: "x" }));
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("descartado");
    expect(enviar).not.toHaveBeenCalled();
    expect((await passo()).status).toBe("skipped");
  });

  it("outra mensagem da MESMA conta saindo → 'ocupado' (o worker adia o job)", async () => {
    const job = await entregue();
    await redisEstado().set(`social:trava:${contaId}`, "outro", "PX", 60_000);
    const enviar = vi.fn(async () => ({ providerMessageId: "x" }));
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("ocupado");
    expect(enviar).not.toHaveBeenCalled();
    await redisEstado().del(`social:trava:${contaId}`);
  });

  it("DM parado na fila há horas → segurado para revisão, não sai fora de contexto", async () => {
    const job = await entregue(new Date(Date.now() - 7 * 3_600_000));
    const enviar = vi.fn(async () => ({ providerMessageId: "x" }));
    expect(await runWithTeam(TEAM, () => processarEnvioSocial(job, enviar))).toBe("vencido");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("dois times: job de outro time não acha a inscrição e nada sai", async () => {
    const job = await entregue();
    const enviar = vi.fn(async () => ({ providerMessageId: "x" }));
    expect(await runWithTeamDb(OUTRO, () => processarEnvioSocial(job, enviar), { userId: "system", role: "system" })).toBe("descartado");
    expect(enviar).not.toHaveBeenCalled();
    expect(await inscricao()).toMatchObject({ waitingFor: MARCA_ENVIO_SOCIAL });
  });
});

describe("extensão primeiro, Playwright só quando é seguro", () => {
  const params = () => ({ teamId: TEAM, accountId: contaId, network: "instagram" as const, to: "@lead", text: "Oi" });

  it("extensão confirmou → não abre Playwright; o @ esperado vai no job", async () => {
    const relay = vi.fn(async () => ({ jobId: "j1", ok: true }));
    const navegador = vi.fn(async () => ({ providerMessageId: "b" }));
    const r = await runWithTeam(TEAM, () => enviarDmSocial(params(), navegador, relay));
    expect(r.providerMessageId).toBe("relay-j1");
    expect(relay).toHaveBeenCalledWith(TEAM, expect.objectContaining({ accountId: contaId, expectedUsername: "vendedora" }));
    expect(navegador).not.toHaveBeenCalled();
  });

  it("extensão pegou e não respondeu (incerto) → NUNCA cai no Playwright (antes: DM duplicado)", async () => {
    const navegador = vi.fn(async () => ({ providerMessageId: "b" }));
    await expect(
      runWithTeam(TEAM, () => enviarDmSocial(params(), navegador, async () => ({ jobId: "j", ok: false, error: "incerto" }))),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(navegador).not.toHaveBeenCalled();
  });

  it("sem extensão com a conta, ou ninguém pegou o job (removido da fila) → Playwright", async () => {
    for (const error of ["no_agent", "timeout"]) {
      const navegador = vi.fn(async () => ({ providerMessageId: "b" }));
      await runWithTeam(TEAM, () => enviarDmSocial(params(), navegador, async () => ({ jobId: "", ok: false, error })));
      expect(navegador).toHaveBeenCalledTimes(1);
    }
  });

  it("códigos da extensão: conta trocada repete; perfil sem botão pula; não confirmado segura", async () => {
    const semNavegador = vi.fn(async () => ({ providerMessageId: "b" }));
    const com = (error: string) =>
      runWithTeam(TEAM, () => enviarDmSocial(params(), semNavegador, async () => ({ jobId: "j", ok: false, error })));
    await expect(com("wrong_account")).rejects.toMatchObject({ outcome: "not_sent", retryable: true });
    await expect(com("sem_botao_mensagem")).rejects.toMatchObject({ outcome: "not_sent", retryable: false });
    await expect(com("nao_confirmado")).rejects.toMatchObject({ outcome: "unknown" });
    expect(semNavegador).not.toHaveBeenCalled();
  });

  it("Playwright achou a sessão deslogada → conta pausada e marcada com erro", async () => {
    const navegador = vi.fn(async () => {
      throw new SessaoSocialInvalida("sessão instagram inválida");
    });
    await expect(
      runWithTeam(TEAM, () => enviarDmSocial(params(), navegador, async () => ({ jobId: "", ok: false, error: "no_agent" }))),
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: contaId } })).toMatchObject({ status: "error", paused: true });
  });
});

describe("executor send_social", () => {
  const node = {
    id: NODE,
    tipo: "send_social",
    config: { canal: "instagram", template: "Oi {nome}", onNoHandle: "skip", aiPersonalize: false },
    nextNodeId: "fim",
  } as never;
  const ctx = (instagram: string | null) => ({
    id: enrId,
    teamId: TEAM,
    contactId: contatoId,
    lastOutboundAt: null,
    round: 1,
    contact: { id: contatoId, nome: "Lead", tags: [], ownerId: null, instagram },
  });

  it("destino que não é perfil (URL de post) → pula sem gastar cota", async () => {
    const r = await runWithTeam(TEAM, () => executeNode(ctx("https://instagram.com/p/Cxyz/"), node));
    expect(r).toMatchObject({ skipped: true, nextNodeId: "fim" });
    expect(await usoDoDia()).toBe(0);
  });

  it("destino válido → consome a cota e devolve a diretiva para a fila social", async () => {
    const r = await runWithTeam(TEAM, () => executeNode(ctx("@Lead_Certo"), node));
    expect(r.social).toMatchObject({ accountId: contaId, network: "instagram", text: "Oi Lead" });
    expect(await usoDoDia()).toBe(1);
  });
});

describe("varredura de órfãs", () => {
  it("DM vivo na fila social não é órfão; DM sumido → o passo é reagendado (a marca decide)", async () => {
    await entregue();
    await basePrisma.enrollment.update({ where: { id: enrId }, data: { nextRunAt: new Date(Date.now() - 40 * 60_000) } });
    const agendar = vi.fn(async (..._a: unknown[]) => {});
    const base = { estado: async () => "completed", remover: async () => {}, agendar };

    // A base de TESTE é compartilhada: a varredura vê outros times; olha só a nossa.
    const nossas = () => agendar.mock.calls.filter((c: unknown[]) => c[0] === enrId);
    await varrerInscricoesOrfas({ limite: 5000, fila: { ...base, estadoSocial: async () => "delayed" } });
    expect(nossas()).toHaveLength(0);

    await varrerInscricoesOrfas({ limite: 5000, fila: { ...base, estadoSocial: async () => null } });
    expect(nossas()).toEqual([[enrId, NODE, 1, undefined, expect.any(Number)]]);
  });
});
