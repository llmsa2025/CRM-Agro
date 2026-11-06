import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Resultado da ligação (produto §D): caixa postal marca o retorno em 2 dias
 * úteis; número errado invalida o número, põe a tag, entra em "Revisar dados"
 * e a próxima campanha conta o contato como "sem WhatsApp". Nada é enviado: a
 * fila da campanha e a checagem de WhatsApp são mockadas.
 */
vi.mock("../campaigns/queue", () => ({
  agendarMontagemDaLista: async () => {},
  getCampaignQueue: () => ({}),
}));
// "Tem WhatsApp?" registra o que foi perguntado e responde "não sei".
const perguntados: string[] = [];
vi.mock("../campaigns/tem-whatsapp", () => ({
  temWhatsApp: async (numeros: string[]) => {
    perguntados.push(...numeros);
    return new Map(numeros.map((n) => [n, { existe: null, nome: null }]));
  },
}));

const { createManualCall, finishManualCall } = await import("./service");
const { markCallOutcome } = await import("./dialer");
const { retornoEmDiasUteis, TAG_NUMERO_ERRADO } = await import("./resultado");
const { DEFAULT_TEAM_CONFIG } = await import("../motor-do-dia/team-config");
const { contatosParaRevisar } = await import("../contacts/service");
const { createCampaign, prepararLista, montarLista } = await import("../campaigns/service");

const TEAM = "00000000-0000-0000-0000-0000000005a1";
const OUTRO = "00000000-0000-0000-0000-0000000005a2";
const NUMERO = "+5565999000501";

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team resultado ligação ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  perguntados.length = 0;
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.appointment.deleteMany({ where: w });
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

/** Contato com WhatsApp (e e-mail, para não cair em "Revisar dados" por falta dele). */
async function contato(teamId: string, nome: string, numero = NUMERO) {
  const c = await basePrisma.contact.create({ data: { teamId, nome } });
  await basePrisma.channelIdentifier.createMany({
    data: [
      { teamId, contactId: c.id, canal: "whatsapp", valor: numero, isPrimary: true },
      { teamId, contactId: c.id, canal: "email", valor: `${c.id}@exemplo.com.br`, isPrimary: true },
    ],
  });
  return c;
}

async function ligar(teamId: string, contactId: string, numero = NUMERO) {
  return runWithTeam(teamId, () => createManualCall({ phoneNumber: numero, contactId }));
}

// Quarta, 30/09/2026, 10:00 em São Paulo.
const QUARTA_10H = new Date("2026-09-30T13:00:00Z");

describe("retorno em 2 dias úteis (calendário do time)", () => {
  const cfg = { ...DEFAULT_TEAM_CONFIG };
  it("quarta 10:00 → sexta 10:00", () => {
    expect(retornoEmDiasUteis(QUARTA_10H, 2, cfg).toISOString()).toBe("2026-10-02T13:00:00.000Z");
  });
  it("pula fim de semana e feriado: quinta 08/10 15:30 → terça 13/10 15:30 (12/10 é feriado)", () => {
    expect(retornoEmDiasUteis(new Date("2026-10-08T18:30:00Z"), 2, cfg).toISOString()).toBe("2026-10-13T18:30:00.000Z");
  });
  it("ligação fora da janela (sexta 19:00) → abertura do 2º dia útil (terça 08:00)", () => {
    expect(retornoEmDiasUteis(new Date("2026-10-02T22:00:00Z"), 2, cfg).toISOString()).toBe("2026-10-06T11:00:00.000Z");
  });
});

describe("caixa postal", () => {
  it("marca o retorno (compromisso de ligação) uma vez só, mesmo finalizando de novo", async () => {
    const c = await contato(TEAM, "Ana");
    const { callId } = await ligar(TEAM, c.id);
    const r1 = await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "voicemail" }, { agora: QUARTA_10H }));
    expect(r1.retorno?.inicio).toBe("2026-10-02T13:00:00.000Z");
    const r2 = await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "voicemail" }, { agora: QUARTA_10H }));
    expect(r2.retorno).toBeNull();

    const ags = await basePrisma.appointment.findMany({ where: { teamId: TEAM } });
    expect(ags).toHaveLength(1);
    expect(ags[0]).toMatchObject({ contactId: c.id, tipo: "ligacao", status: "pendente", id: r1.retorno!.appointmentId });
    expect(ags[0]!.titulo).toContain("Ana");
    const call = await basePrisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call).toMatchObject({ status: "no_answer", outcome: "voicemail" });
    const act = await basePrisma.activity.findFirstOrThrow({ where: { teamId: TEAM, tipo: "call" } });
    expect(act.conteudo).toBe("Ligação caiu na caixa postal");
    expect(act.meta).toMatchObject({ outcome: "voicemail", retornoAppointmentId: r1.retorno!.appointmentId });
  });

  it("discador: caixa postal também marca o retorno", async () => {
    const c = await contato(TEAM, "Bia");
    const { callId } = await ligar(TEAM, c.id);
    await runWithTeam(TEAM, () => markCallOutcome(callId, "voicemail", { agora: QUARTA_10H }));
    const ag = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(ag).toMatchObject({ tipo: "ligacao", contactId: c.id, inicio: new Date("2026-10-02T13:00:00Z") });
  });
});

describe("número errado", () => {
  it("invalida o número, põe a tag, entra em 'Revisar dados' e tira da campanha em curso", async () => {
    const c = await contato(TEAM, "Caio");
    const emCurso = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Em curso", status: "sending" } });
    await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: emCurso.id, contactId: c.id, telefone: NUMERO, status: "queued" },
    });
    const { callId } = await ligar(TEAM, c.id);
    const r = await runWithTeam(TEAM, () =>
      finishManualCall(callId, { outcome: "wrong_number", disposition: "é de outra pessoa" }),
    );
    expect(r).toMatchObject({ outcome: "wrong_number", numerosInvalidados: 1, retorno: null });

    const idt = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, canal: "whatsapp", valor: NUMERO } });
    expect(idt.invalido).toBe(true);
    expect(idt.invalidoMotivo).toMatch(/^número errado \(ligação de \d{4}-\d{2}-\d{2}\)$/);
    const k = await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(k.tags.filter((t) => t === TAG_NUMERO_ERRADO)).toHaveLength(1);
    const call = await basePrisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call).toMatchObject({ status: "failed", outcome: "wrong_number", disposition: "é de outra pessoa" });
    expect(await basePrisma.campaignRecipient.findFirst({ where: { campaignId: emCurso.id } })).toMatchObject({
      status: "skipped",
      motivo: "número errado",
    });

    const revisar = await runWithTeam(TEAM, () => contatosParaRevisar());
    expect(revisar.find((x) => x.id === c.id)).toMatchObject({
      faltaWhatsapp: true,
      faltaEmail: false,
      numeroErrado: { valor: NUMERO, motivo: idt.invalidoMotivo },
    });

    // Repetir não duplica a tag.
    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "wrong_number" }));
    const k2 = await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(k2.tags.filter((t) => t === TAG_NUMERO_ERRADO)).toHaveLength(1);
  });

  it("a próxima campanha conta o contato como sem WhatsApp — por filtro e por lista colada — sem perguntar à Evolution", async () => {
    const c = await contato(TEAM, "Duda");
    const ok = await contato(TEAM, "Edu", "+5565999000502");
    const { callId } = await ligar(TEAM, c.id);
    await runWithTeam(TEAM, () => markCallOutcome(callId, "wrong_number"));

    const porFiltro = await runWithTeam(TEAM, () => createCampaign("Filtro"));
    const f = await runWithTeam(TEAM, () => prepararLista(porFiltro.id, { tipo: "filtro", contactIds: [c.id, ok.id] }));
    const rf = await runWithTeam(TEAM, () => montarLista(porFiltro.id, f.versao, { historico: async () => false }));
    expect(rf).toMatchObject({ linhas: 2, semWhatsApp: 1, invalidos: 0 });

    const colados = await runWithTeam(TEAM, () => createCampaign("Colados"));
    // O mesmo celular sem o nono dígito também é o número errado.
    const l = await runWithTeam(TEAM, () =>
      prepararLista(colados.id, { tipo: "colados", texto: "Duda; 65 9900-0501\nEdu; 65999000502" }),
    );
    const rc = await runWithTeam(TEAM, () => montarLista(colados.id, l.versao, { historico: async () => false }));
    expect(rc).toMatchObject({ linhas: 2, semWhatsApp: 1, invalidos: 0 });

    const dest = await basePrisma.campaignRecipient.findMany({
      where: { campaignId: { in: [porFiltro.id, colados.id] } },
      select: { contactId: true },
    });
    expect(dest.map((d) => d.contactId)).toEqual([ok.id, ok.id]);
    expect(perguntados).not.toContain(NUMERO);
    expect(perguntados).not.toContain("+556599000501");
  });
});

describe("dois times", () => {
  it("número errado no time A não mexe no mesmo número do time B; A não finaliza ligação de B", async () => {
    const a = await contato(TEAM, "Fabi");
    const b = await contato(OUTRO, "Fabi do B");
    const { callId } = await ligar(TEAM, a.id);
    await runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "wrong_number" }));

    const idtB = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: OUTRO, canal: "whatsapp" } });
    expect(idtB.invalido).toBe(false);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: b.id } })).tags).not.toContain(TAG_NUMERO_ERRADO);
    expect((await runWithTeam(OUTRO, () => contatosParaRevisar())).find((x) => x.id === b.id)).toBeUndefined();

    const campB = await runWithTeam(OUTRO, () => createCampaign("B"));
    const l = await runWithTeam(OUTRO, () => prepararLista(campB.id, { tipo: "filtro", contactIds: [b.id] }));
    expect(await runWithTeam(OUTRO, () => montarLista(campB.id, l.versao, { historico: async () => false }))).toMatchObject({
      semWhatsApp: 0,
    });

    const ligB = await ligar(OUTRO, b.id);
    await expect(runWithTeam(TEAM, () => finishManualCall(ligB.callId, { outcome: "wrong_number" }))).rejects.toMatchObject({
      name: "CallNotFound",
    });
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: ligB.callId } })).outcome).toBeNull();
  });

  it("viewer não finaliza ligação", async () => {
    const c = await contato(TEAM, "Gil");
    const { callId } = await ligar(TEAM, c.id);
    await expect(
      runWithTeam(TEAM, () => finishManualCall(callId, { outcome: "voicemail" }), { userId: "v", role: "viewer" }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
