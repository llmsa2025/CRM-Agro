import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ProdutorEnricher } from "./produtor";
import { applyEnrichment } from "./reconcile";
import { PRODUTOR_REGRA_VERSAO } from "../produtor/classify";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000e4"];

/**
 * Enriquecimento — o reconciler grava colunas dedicadas + Fact append-only, sem
 * sobrescrever valor humano. Testa o ProdutorEnricher (regra pura) + applyEnrichment
 * sem tocar a rede (CnpjEnricher usa fetch — coberto pelo classify.test unitário).
 */
const TEAM = "00000000-0000-0000-0000-0000000000e4";

beforeAll(async () => {
  await basePrisma.team.upsert({
    where: { id: TEAM },
    update: { name: "Team Enrich (test)" },
    create: { id: TEAM, name: "Team Enrich (test)" },
  });
});

beforeEach(async () => {
  await basePrisma.enrichmentFact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contactCompany.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.company.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

describe("applyEnrichment + ProdutorEnricher", () => {
  it("classifica produtor, grava coluna dedicada e Fact append-only", async () => {
    const contactId = await runWithTeam(TEAM, async () => {
      const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Produtor Soja" } });
      const res = await ProdutorEnricher.run(
        {
          contactId: c.id,
          produtorRegraVersao: null,
          empresas: [
            {
              cnae: "0115-6/00", // soja (produção direta +40)
              cnaesSecundarios: [],
              iesTipos: [{ tipo: "Produtor Rural", habilitada: true }],
              razaoSocial: "Fazenda Boa Terra",
            },
          ],
        },
        {},
      );
      expect(res).not.toBeNull();
      await applyEnrichment(res!, { mode: "prefer-higher-confidence" });
      return c.id;
    });

    const contact = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.produtorLabel).toBe("produtor");
    expect(contact.isProdutor).toBe(true);
    expect(contact.produtorRegraVersao).toBe(PRODUTOR_REGRA_VERSAO);

    const facts = await basePrisma.enrichmentFact.findMany({ where: { targetId: contactId } });
    expect(facts.length).toBeGreaterThanOrEqual(4);
    const labelFact = facts.find((f) => f.field === "produtorLabel");
    expect(labelFact?.appliedAt).not.toBeNull();
    expect(labelFact?.enricherKey).toBe("produtor");
  });

  it("never-override-human: valor humano não é sobrescrito, mas o Fact é registrado", async () => {
    const contactId = await runWithTeam(TEAM, async () => {
      const c = await basePrisma.contact.create({
        data: { teamId: TEAM, nome: "Manual", produtorLabel: "nao_produtor", produtorRegraVersao: "manual" },
      });
      // Marca produtorLabel como decisão HUMANA (confidence 1, source human).
      await basePrisma.enrichmentFact.create({
        data: {
          teamId: TEAM,
          targetType: "contact",
          targetId: c.id,
          field: "produtorLabel",
          value: "nao_produtor",
          enricherKey: "human",
          enricherVersion: "human",
          source: "human",
          confidence: 1,
        },
      });
      const res = await ProdutorEnricher.run(
        {
          contactId: c.id,
          produtorRegraVersao: null,
          empresas: [{ cnae: "0115-6/00", iesTipos: [{ tipo: "Produtor Rural", habilitada: true }] }],
        },
        {},
      );
      await applyEnrichment(res!, { mode: "prefer-higher-confidence" });
      return c.id;
    });

    const contact = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    // A máquina classificaria como "produtor", mas o humano venceu.
    expect(contact.produtorLabel).toBe("nao_produtor");
    // ...e a proveniência da máquina ficou registrada (não promovida).
    const machineFact = await basePrisma.enrichmentFact.findFirst({
      where: { targetId: contactId, field: "produtorLabel", source: "regra" },
    });
    expect(machineFact).toBeTruthy();
    expect(machineFact?.appliedAt).toBeNull();
  });
});
