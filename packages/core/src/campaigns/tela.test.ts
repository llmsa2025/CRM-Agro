import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { linhasDaPlanilha, listarDestinatarios, PlanilhaSemTelefone } from "./tela";
import { CampaignNotFound, MAX_LINHAS_DA_LISTA } from "./service";

/**
 * O que só a TELA das Campanhas usa (produto §A.6): planilha → linhas da lista
 * (mesmo leitor da importação) e as listas de destinatários por status.
 */
const TEAM = "00000000-0000-0000-0000-0000000003b2";
const OUTRO = "00000000-0000-0000-0000-0000000003b3";

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Campanhas tela ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

describe("planilha → linhas da lista", () => {
  it("acha telefone, nome, empresa e cidade pelo nome da coluna (o mesmo leitor da importação)", () => {
    const csv = ["Nome;Fazenda;Município;Telefone (WhatsApp);Obs", "Ana;Boa Vista;Sorriso;(65) 99900-0001;x", ";;;;", "Beto;;;65999000002;"].join("\n");
    expect(linhasDaPlanilha(csv)).toEqual([
      { telefone: "(65) 99900-0001", nome: "Ana", empresa: "Boa Vista", cidade: "Sorriso" },
      { telefone: "65999000002", nome: "Beto" },
    ]);
  });

  it("sem coluna de telefone → erro nomeado; acima do teto → recusa", () => {
    expect(() => linhasDaPlanilha("Nome;Cidade\nAna;Sorriso")).toThrow(PlanilhaSemTelefone);
    const muitas = ["Telefone", ...Array.from({ length: MAX_LINHAS_DA_LISTA + 1 }, (_, i) => `659${String(i).padStart(8, "0")}`)].join("\n");
    expect(() => linhasDaPlanilha(muitas)).toThrow(/ListaGrandeDemais/);
  });
});

describe("destinatários por status (segurados, respostas, fila)", () => {
  async function campanhaCom(status: Array<"held" | "queued" | "replied">) {
    const c = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Tela" } });
    const base = Date.now();
    for (const [i, s] of status.entries()) {
      const k = await basePrisma.contact.create({ data: { teamId: TEAM, nome: `Lead ${i}` } });
      await basePrisma.campaignRecipient.create({
        data: { teamId: TEAM, campaignId: c.id, contactId: k.id, status: s, telefone: `+55659990000${i}`, createdAt: new Date(base + i) },
      });
    }
    return c;
  }

  it("filtra por status, traz o nome do contato e pagina em ordem pelo cursor", async () => {
    const c = await campanhaCom(["held", "queued", "held", "replied", "held"]);
    const p1 = await runWithTeam(TEAM, () => listarDestinatarios(c.id, { status: ["held"], take: 2 }));
    expect(p1.items.map((i) => i.nome)).toEqual(["Lead 0", "Lead 2"]);
    expect(p1.items[0]).toMatchObject({ status: "held", telefone: "+556599900000" });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await runWithTeam(TEAM, () => listarDestinatarios(c.id, { status: ["held"], take: 2, cursor: p1.nextCursor! }));
    expect(p2.items.map((i) => i.nome)).toEqual(["Lead 4"]);
    expect(p2.nextCursor).toBeNull();
    const todos = await runWithTeam(TEAM, () => listarDestinatarios(c.id));
    expect(todos.items).toHaveLength(5);
  });

  it("dois times: o B não lista os destinatários da campanha do A", async () => {
    const c = await campanhaCom(["held"]);
    await expect(runWithTeam(OUTRO, () => listarDestinatarios(c.id))).rejects.toBeInstanceOf(CampaignNotFound);
  });
});
