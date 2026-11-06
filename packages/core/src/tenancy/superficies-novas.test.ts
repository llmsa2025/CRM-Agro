import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * Teste "dois times" das SUPERFÍCIES NOVAS de 09/2026 (campanhas, mapa,
 * importação, kanban paginado, tarefas do dia): o time B, com o próprio login,
 * não lê, não lista e não altera nada do time A. Complementa o
 * `assert-owned.test.ts` (FK vinda do cliente) — aqui é o acesso por id/lista.
 *
 * Filas mockadas: nada chega ao worker de produção.
 */
vi.mock("../campaigns/queue", () => ({
  CAMPAIGN_QUEUE: "campaign",
  agendarMontagemDaLista: vi.fn(),
  agendarTick: vi.fn(),
  campaignJobId: (j: { kind: string; campaignId: string }) => `${j.kind}:${j.campaignId}`,
  getCampaignQueue: () => ({ add: vi.fn(), getJob: vi.fn() }),
}));
vi.mock("../importacao/fila", () => ({
  IMPORT_QUEUE: "import",
  IMPORT_TENTATIVAS: 3,
  enfileirarImportacao: vi.fn(),
}));

const { createCampaign, getCampaign, listCampaigns, saveStep, liberarSegurados, CampaignNotFound } = await import("../campaigns/service");
const { listarDestinatarios } = await import("../campaigns/tela");
const { cancelCampaign } = await import("../campaigns/controle");
const { pontosDoMapa, resumoDoMapa, contatosPerto } = await import("../geo/mapa");
const { getImportJob, listImportJobs } = await import("../importacao/jobs");
const { ImportJobNotFound } = await import("../importacao/errors");
const { getFunnelBoard, listFunnelDeals } = await import("../funnels/board");
const { createFunnelWithStages } = await import("../funnels/service");
const { FunnelNotFound } = await import("../funnels/errors");
const { markTaskDone, undoTaskDone } = await import("../dashboard/tarefas-feitas");

const TEAM_A = "00000000-0000-0000-0000-0000000000c9";
const TEAM_B = "00000000-0000-0000-0000-0000000000d9";
const USER_A = "00000000-0000-0000-0000-0000000000ca";
const USER_B = "00000000-0000-0000-0000-0000000000da";
const TIMES = [TEAM_A, TEAM_B];
const emA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_A, fn, { userId: USER_A, role: "owner" });
const emB = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_B, fn, { userId: USER_B, role: "owner" });

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (superfícies novas)"],
    [TEAM_B, "Team B (superfícies novas)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
  // DailyTaskState tem FK para User: os atores precisam existir.
  for (const [id, teamId, email] of [
    [USER_A, TEAM_A, "dono-a-superficies@teste.local"],
    [USER_B, TEAM_B, "dono-b-superficies@teste.local"],
  ] as const) {
    await basePrisma.user.upsert({ where: { id }, update: { teamId }, create: { id, teamId, name: "Dono", email, role: "owner" } });
  }
});

beforeEach(async () => {
  const w = { teamId: { in: TIMES } };
  await basePrisma.dailyTaskState.deleteMany({ where: w });
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.importJob.deleteMany({ where: w });
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

describe("campanhas — o time B não vê nem mexe na campanha do time A", () => {
  it("getCampaign / saveStep / listarDestinatarios / liberarSegurados / cancelCampaign recusam; listCampaigns não lista", async () => {
    const c = await emA(() => createCampaign("Campanha do A"));
    expect((await emA(() => getCampaign(c.id))).nome).toBe("Campanha do A");

    await expect(emB(() => getCampaign(c.id))).rejects.toBeInstanceOf(CampaignNotFound);
    await expect(emB(() => saveStep(c.id, 1, { diasSemCampanha: 10 }))).rejects.toBeInstanceOf(CampaignNotFound);
    await expect(emB(() => listarDestinatarios(c.id, {}))).rejects.toBeInstanceOf(CampaignNotFound);
    await expect(emB(() => liberarSegurados(c.id, "todos"))).rejects.toBeInstanceOf(CampaignNotFound);
    await expect(emB(() => cancelCampaign(c.id))).rejects.toBeInstanceOf(CampaignNotFound);
    expect((await emB(() => listCampaigns())).map((x) => x.id)).not.toContain(c.id);

    // Intacta no A.
    const depois = await basePrisma.campaign.findUnique({ where: { id: c.id } });
    expect(depois?.status).toBe("draft");
    expect(depois?.diasSemCampanha).toBe(30);
  });
});

describe("mapa — pontos, resumo e 'perto daqui' só do próprio time", () => {
  it("o contato localizado do A não aparece para o B", async () => {
    const contato = await basePrisma.contact.create({
      data: { teamId: TEAM_A, nome: "Produtor do A", cidade: "Sorriso", estado: "MT", latitude: -12.545, longitude: -55.72, geoPrecisao: "cidade" },
    });
    const pontosA = await emA(() => pontosDoMapa({}));
    expect(pontosA.tipo === "pontos" ? pontosA.ids : []).toContain(contato.id);
    expect((await emA(() => resumoDoMapa({}))).total).toBeGreaterThanOrEqual(1);

    const pontosB = await emB(() => pontosDoMapa({}));
    expect(pontosB.tipo === "pontos" ? pontosB.ids : []).not.toContain(contato.id);
    expect(pontosB.total).toBe(0);
    expect((await emB(() => resumoDoMapa({}))).total).toBe(0);
    await expect(emB(() => contatosPerto({ contactId: contato.id, km: 50 }))).rejects.toThrow();
  });
});

describe("importação — o job do A não existe para o B", () => {
  it("getImportJob recusa e listImportJobs não lista", async () => {
    const job = await basePrisma.importJob.create({ data: { teamId: TEAM_A, nomeArquivo: "a.csv", mapeamento: ["nome"], opcoes: {} } });
    expect((await emA(() => getImportJob(job.id))).id).toBe(job.id);
    await expect(emB(() => getImportJob(job.id))).rejects.toBeInstanceOf(ImportJobNotFound);
    expect((await emB(() => listImportJobs())).map((j) => j.id)).not.toContain(job.id);
  });
});

describe("kanban paginado — o funil do A não abre para o B", () => {
  it("getFunnelBoard e listFunnelDeals recusam", async () => {
    const f = await emA(() => createFunnelWithStages({ nome: "Vendas A", tipo: "vendas", stages: ["Novo", "Ganho"] }));
    expect((await emA(() => getFunnelBoard(f.id))).stages.length).toBe(2);
    await expect(emB(() => getFunnelBoard(f.id))).rejects.toBeInstanceOf(FunnelNotFound);
    await expect(emB(() => listFunnelDeals(f.id, {}))).rejects.toBeInstanceOf(FunnelNotFound);
  });
});

describe("tarefas do dia — feita por um usuário fica só no time dele", () => {
  it("o B não desfaz a tarefa do A", async () => {
    const chave = "deal_parado:abc123:2026-09-27";
    await emA(() => markTaskDone(chave));
    expect(await basePrisma.dailyTaskState.count({ where: { teamId: TEAM_A, chave } })).toBe(1);
    expect((await emB(() => undoTaskDone(chave))).desfeita).toBe(false);
    expect(await basePrisma.dailyTaskState.count({ where: { teamId: TEAM_A, chave } })).toBe(1);
  });
});
