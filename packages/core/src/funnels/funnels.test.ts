import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import * as contacts from "../contacts/index";
import * as funnels from "./index";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000b2"];

const TEAM_A = "00000000-0000-0000-0000-0000000000a1";
const TEAM_B = "00000000-0000-0000-0000-0000000000b2";

let funnelAId: string;
let stage1Id: string;
let stage2Id: string;
let contactAId: string;

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (test)"],
    [TEAM_B, "Team B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  await basePrisma.deal.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.stage.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.funnel.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });

  // setup: funil + 2 etapas + 1 contato no team A
  const setup = await runWithTeam(TEAM_A, async () => {
    const f = await funnels.createFunnel({ nome: "Vendas A", tipo: "pre_vendas" });
    const s1 = await funnels.createStage({ funnelId: f.id, nome: "Novo", ordem: 0 });
    const s2 = await funnels.createStage({ funnelId: f.id, nome: "Qualificado", ordem: 1 });
    const c = await contacts.create({ nome: "Lead A", tags: [] });
    funnelAId = f.id;
    stage1Id = s1.id;
    stage2Id = s2.id;
    contactAId = c.id;
  });
  void setup;
});

describe("funnels service — isolamento por teamId", () => {
  it("team B não enxerga funil/deal do team A", async () => {
    await runWithTeam(TEAM_A, async () => {
      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId, valor: 5000 });
    });

    const funnelsA = await runWithTeam(TEAM_A, async () => (await funnels.listFunnels()).items);
    const funnelsB = await runWithTeam(TEAM_B, async () => (await funnels.listFunnels()).items);
    expect(funnelsA).toHaveLength(1);
    expect(funnelsB).toHaveLength(0);

    // getFunnel do team A pelo id, lançando NotFound no contexto do team B
    await expect(runWithTeam(TEAM_B, async () => await funnels.getFunnel(funnelAId))).rejects.toThrow(
      /FunnelNotFound/,
    );
  });
});

describe("funnels service — moveDeal", () => {
  it("troca de etapa, atualiza enteredStageAt e cria Activity stage_change com de/para", async () => {
    const deal = await runWithTeam(TEAM_A, async () =>
      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId, valor: 1000 }),
    );

    const before = Date.now();
    const moved = await runWithTeam(TEAM_A, async () => await funnels.moveDeal(deal.id, stage2Id));
    const after = Date.now();

    expect(moved.stageId).toBe(stage2Id);
    expect(new Date(moved.enteredStageAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(moved.enteredStageAt).getTime()).toBeLessThanOrEqual(after);

    // Activity registrada no contato
    const contact = await runWithTeam(TEAM_A, async () => await contacts.getById(contactAId));
    const stageChange = contact.activities.find((a) => a.tipo === "stage_change");
    expect(stageChange).toBeDefined();
    expect(stageChange?.meta).toMatchObject({ de: "Novo", para: "Qualificado", dealId: deal.id });
    expect(stageChange?.conteudo).toContain("Novo");
    expect(stageChange?.conteudo).toContain("Qualificado");
  });

  it("moveDeal é no-op se já está na etapa destino", async () => {
    const deal = await runWithTeam(TEAM_A, async () =>
      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId }),
    );
    const moved = await runWithTeam(TEAM_A, async () => await funnels.moveDeal(deal.id, stage1Id));
    expect(moved.stageId).toBe(stage1Id);

    const contact = await runWithTeam(TEAM_A, async () => await contacts.getById(contactAId));
    expect(contact.activities.filter((a) => a.tipo === "stage_change")).toHaveLength(0);
  });

  it("moveDeal lança StageNotFound se etapa destino não existe", async () => {
    const deal = await runWithTeam(TEAM_A, async () =>
      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId }),
    );
    await expect(
      runWithTeam(TEAM_A, async () => await funnels.moveDeal(deal.id, "stage-inexistente")),
    ).rejects.toThrow(/StageNotFound/);
  });

  it("moveDeal lança DealNotFound se deal não existe no time", async () => {
    await expect(
      runWithTeam(TEAM_A, async () => await funnels.moveDeal("deal-inexistente", stage2Id)),
    ).rejects.toThrow(/DealNotFound/);
  });
});

describe("funnels service — etapas (código, CRUD, reorder) e negócios", () => {
  it("createStage/createFunnel geram código estável", async () => {
    await runWithTeam(TEAM_A, async () => {
      const f = await basePrisma.funnel.findUniqueOrThrow({ where: { id: funnelAId } });
      expect(f.codigo).toBeTruthy();
      const s = await basePrisma.stage.findUniqueOrThrow({ where: { id: stage1Id } });
      expect(s.codigo).toBeTruthy();
    });
  });

  it("createFunnelWithStages cria as colunas na ordem informada, com código", async () => {
    await runWithTeam(TEAM_A, async () => {
      const f = await funnels.createFunnelWithStages({
        nome: "Custom",
        tipo: "vendas",
        stages: ["A", "B", "C"],
      });
      const stages = await basePrisma.stage.findMany({
        where: { funnelId: f.id },
        orderBy: { ordem: "asc" },
      });
      expect(stages.map((s) => s.nome)).toEqual(["A", "B", "C"]);
      expect(stages.every((s) => s.codigo)).toBe(true);
    });
  });

  it("addStageToEnd calcula a próxima ordem; reorderStages reordena sem colidir", async () => {
    await runWithTeam(TEAM_A, async () => {
      const s3 = await funnels.addStageToEnd(funnelAId, "Fechado");
      expect(s3.ordem).toBe(2);
      await funnels.reorderStages(funnelAId, [s3.id, stage1Id, stage2Id]);
      const stages = await basePrisma.stage.findMany({
        where: { funnelId: funnelAId },
        orderBy: { ordem: "asc" },
      });
      expect(stages.map((s) => s.id)).toEqual([s3.id, stage1Id, stage2Id]);
    });
  });

  it("deleteStage bloqueia se a etapa tem negócios (StageNotEmpty)", async () => {
    await runWithTeam(TEAM_A, async () => {
      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId });
      await expect(funnels.deleteStage(stage1Id)).rejects.toThrow(/StageNotEmpty/);
      // etapa vazia é excluível
      await funnels.deleteStage(stage2Id);
      const restantes = await basePrisma.stage.count({ where: { id: stage2Id } });
      expect(restantes).toBe(0);
    });
  });

  it("duplicateDeal copia o negócio na mesma etapa", async () => {
    await runWithTeam(TEAM_A, async () => {
      const d = await funnels.createDeal({
        funnelId: funnelAId,
        stageId: stage1Id,
        contactId: contactAId,
        valor: 500,
      });
      const dup = await funnels.duplicateDeal(d.id);
      expect(dup.stageId).toBe(stage1Id);
      expect(Number(dup.valor)).toBe(500);
      expect(dup.id).not.toBe(d.id);
    });
  });
});

describe("deleteFunnel — trava com negócios", () => {
  it("bloqueia excluir funil com negócio e libera quando vazio", async () => {
    await runWithTeam(TEAM_A, async () => {
      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId });
      await expect(funnels.deleteFunnel(funnelAId)).rejects.toThrow(/FunnelNotEmpty/);

      // funil novo e vazio é excluível
      const vazio = await funnels.createFunnelWithStages({ nome: "Vazio", tipo: "vendas", stages: ["X"] });
      await funnels.deleteFunnel(vazio.id);
      expect(await basePrisma.funnel.count({ where: { id: vazio.id } })).toBe(0);
    });
  });

  it("getDealDetail traz negócio + contato + etapa/funil + histórico", async () => {
    await runWithTeam(TEAM_A, async () => {
      const d = await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId, valor: 300 });
      const detail = await funnels.getDealDetail(d.id);
      expect(detail.deal.id).toBe(d.id);
      expect(detail.deal.contact.nome).toBe("Lead A");
      expect(detail.deal.stage.funnel.codigo).toBeTruthy();
      expect(Array.isArray(detail.activities)).toBe(true);
    });
  });
});

describe("criar card (ensureDeal) vs mover etapa (moveDealInFunnel)", () => {
  it("ensureDeal deduplica: cria uma vez, não duplica no mesmo funil", async () => {
    await runWithTeam(TEAM_A, async () => {
      const a = await funnels.ensureDeal(funnelAId, stage1Id, contactAId);
      expect(a.created).toBe(true);
      const b = await funnels.ensureDeal(funnelAId, stage2Id, contactAId);
      expect(b.created).toBe(false); // já existe negócio aberto no funil
      const abertos = await basePrisma.deal.count({ where: { contactId: contactAId, funnelId: funnelAId, status: "open" } });
      expect(abertos).toBe(1);
    });
  });

  it("moveDealInFunnel move o negócio existente; sem negócio → moved:false", async () => {
    await runWithTeam(TEAM_A, async () => {
      const semNegocio = await funnels.moveDealInFunnel(contactAId, funnelAId, stage2Id);
      expect(semNegocio.moved).toBe(false);

      await funnels.createDeal({ funnelId: funnelAId, stageId: stage1Id, contactId: contactAId });
      const res = await funnels.moveDealInFunnel(contactAId, funnelAId, stage2Id);
      expect(res.moved).toBe(true);
      const deal = await basePrisma.deal.findFirstOrThrow({ where: { contactId: contactAId, funnelId: funnelAId } });
      expect(deal.stageId).toBe(stage2Id);
    });
  });
});
