import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma, db } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Modelo das Campanhas (produto §A.1): tenancy da extensão (dois times),
 * destinatário único por campanha e cache global do "Tem WhatsApp?".
 */
const TEAM = "00000000-0000-0000-0000-0000000003a9";
const OUTRO = "00000000-0000-0000-0000-0000000003aa";

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Campanhas modelo ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

async function campanhaCom1Destinatario(teamId: string) {
  const contato = await basePrisma.contact.create({ data: { teamId, nome: "Lead" } });
  const campanha = await basePrisma.campaign.create({ data: { teamId, nome: `Safra ${teamId.slice(-2)}` } });
  await basePrisma.campaignRecipient.create({ data: { teamId, campaignId: campanha.id, contactId: contato.id } });
  return { contato, campanha };
}

describe("Campaign / CampaignRecipient", () => {
  it("dois times: cada um só vê as próprias campanhas e destinatários; criação recebe o time do contexto", async () => {
    const a = await campanhaCom1Destinatario(TEAM);
    const b = await campanhaCom1Destinatario(OUTRO);
    await runWithTeam(TEAM, async () => {
      expect((await db().campaign.findMany()).map((c) => c.id)).toEqual([a.campanha.id]);
      expect(await db().campaignRecipient.count()).toBe(1);
      expect(await db().campaign.findUnique({ where: { id: b.campanha.id } })).toBeNull();
      const nova = await db().campaign.create({ data: { nome: "Nova", teamId: OUTRO } as never });
      expect(nova.teamId).toBe(TEAM);
      // Padrões do ritmo (decisão 7, confirmado pelo dono em 27/09).
      expect(nova).toMatchObject({
        status: "draft",
        janelaInicio: "08:30",
        pausaAlmocoInicio: "11:30",
        pausaAlmocoFim: "13:30",
        janelaFim: "17:30",
        intervaloMinS: 60,
        intervaloMaxS: 180,
        loteTamanho: 20,
        pausaLoteMinM: 15,
        pausaLoteMaxM: 25,
        regraJaConversou: "hold",
        diasSemCampanha: 30,
      });
    });
  });

  it("um contato entra UMA vez na campanha (único campanha+contato); excluir o contato leva o destinatário junto", async () => {
    const { contato, campanha } = await campanhaCom1Destinatario(TEAM);
    await expect(
      basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: campanha.id, contactId: contato.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await basePrisma.contact.delete({ where: { id: contato.id } });
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: campanha.id } })).toBe(0);
  });

  it("WhatsAppNumberCheck é global (sem time): o db() do time lê e grava sem filtro", async () => {
    const numero = `+55659${Date.now().toString().slice(-8)}`;
    await runWithTeam(TEAM, () => db().whatsAppNumberCheck.upsert({ where: { numero }, create: { numero, existe: true }, update: {} }));
    const lido = await runWithTeam(OUTRO, () => db().whatsAppNumberCheck.findUnique({ where: { numero } }));
    expect(lido?.existe).toBe(true);
    await basePrisma.whatsAppNumberCheck.delete({ where: { numero } });
  });
});

