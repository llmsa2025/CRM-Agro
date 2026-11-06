import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import * as contacts from "../contacts/index";
import { updateTeamConfig } from "../motor-do-dia/team-config";
import { DEFAULT_TZ } from "../motor-do-dia/tz";
import {
  startDialerSession,
  getNextDialerSlot,
  markCallOutcome,
  getDialerStats,
  placarDoDia,
  contarPlacar,
  type DialerOutcome,
  type LinhaDoPlacar,
} from "./dialer";

/**
 * Testes do discador progressivo.
 *
 * Padrão: integration tests com Postgres local (como service.test.ts e
 * touch-budget.test.ts). Times dummy via `runWithTeam` + `basePrisma` para
 * seed/limpeza cross-team. `db()` lê teamId do ALS — todos os serviços rodam
 * DENTRO de `runWithTeam`.
 *
 * O `business-hours.canCallNow()` é mockado para não depender do horário real
 * de execução. Por default retorna `true` (libera ligações); testes que
 * exercitam `respectBusinessHours=true` fora da janela comercial trocam o
 * retorno para `false`.
 */
vi.mock("../motor-do-dia/business-hours", async (importActual) => {
  const actual = (await importActual()) as typeof import("../motor-do-dia/business-hours");
  return { ...actual, canCallNow: vi.fn(() => true) };
});
// Importado depois do mock para receber a referência controlável (vi.fn).
import { canCallNow } from "../motor-do-dia/business-hours";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000d5", "00000000-0000-0000-0000-0000000000e6"];

// Time de teste (hex válido). DEV_TEAM_ID (000...001) é do seed — usamos outro
// para nunca colidir com dados da base.
const TEAM_D = "00000000-0000-0000-0000-0000000000d5";


beforeAll(async () => {
  await basePrisma.team.upsert({
    where: { id: TEAM_D },
    update: { name: "Team D (dialer)" },
    create: { id: TEAM_D, name: "Team D (dialer)" },
  });
});

beforeEach(async () => {
  // Limpa ligações/atividades/identifiers/contatos entre testes (todos os times).
  await basePrisma.call.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.teamConfig.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  // Default: dentro do horário comercial (não bloqueia getNextDialerSlot).
  vi.mocked(canCallNow).mockReturnValue(true);
});

afterEach(() => {
  // Devolve o relógio de verdade. Antes, `vi.setSystemTime(REAL_NOW)` deixava o
  // Date CONGELADO no instante da carga — e, no pool single-fork, para todos os
  // arquivos seguintes do processo (laços com prazo em Date.now() nunca acabavam).
  vi.useRealTimers();
});

// ─── startDialerSession ────────────────────────────────────────────────

describe("dialer — startDialerSession", () => {
  it("cria sessão com stats zeradas quando não há ligações no dia", async () => {
    const s = await runWithTeam(TEAM_D, () => startDialerSession());

    expect(s.id).toMatch(/^dialer-\d{4}-\d{2}-\d{2}$/);
    expect(s.respectBusinessHours).toBe(false);
    expect(s.total).toBe(0);
    expect(s.answered).toBe(0);
    expect(s.noAnswer).toBe(0);
    expect(s.busy).toBe(0);
    expect(s.skipped).toBe(0);
    expect(s.remaining).toBe(0);
  });

  it("respeita respectBusinessHours=true ao abrir a sessão", async () => {
    const s = await runWithTeam(TEAM_D, () =>
      startDialerSession({ respectBusinessHours: true }),
    );
    expect(s.respectBusinessHours).toBe(true);
  });

  it("a sessão é por dia — id tem o formato dialer-YYYY-MM-DD", async () => {
    // Fixa o relógio global em 23/07/2026 (determinístico).
    vi.setSystemTime(new Date("2026-07-23T15:00:00Z"));
    const s = await runWithTeam(TEAM_D, () => startDialerSession());
    expect(s.id).toBe("dialer-2026-07-23");
  });
});

// ─── getNextDialerSlot ─────────────────────────────────────────────────

describe("dialer — getNextDialerSlot", () => {
  it("retorna null quando não há contatos elegíveis", async () => {
    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot).toBeNull();
  });

  it("retorna null quando respectBusinessHours=true e fora do horário comercial", async () => {
    // Cria um contato elegível para provar que o null vem do horário, não da
    // falta de contato.
    await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead BH", telefone: "(11) 91111-0001", tags: [] }),
    );
    await runWithTeam(TEAM_D, () => startDialerSession({ respectBusinessHours: true }));
    vi.mocked(canCallNow).mockReturnValue(false);

    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot).toBeNull();
  });

  it("retorna slot com callId, contactId, contactName e phoneNumber", async () => {
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Slot", telefone: "(11) 99999-8888", tags: [] }),
    );

    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot).not.toBeNull();
    expect(slot!.callId).toEqual(expect.any(String));
    expect(slot!.contactId).toBe(c.id);
    expect(slot!.contactName).toBe("Lead Slot");
    expect(slot!.phoneNumber).toBe("+5511999998888"); // normalizado para E.164
    expect(slot!.priority).toBe("alta"); // contato sem toques anteriores
    expect(slot!.touchCount).toBe(0);

    // Cria a Call com status scheduled (rastreabilidade do discador).
    const call = await basePrisma.call.findUnique({ where: { id: slot!.callId } });
    expect(call?.status).toBe("scheduled");
    expect(call?.direction).toBe("outbound");
    expect(call?.provider).toBe("manual");
  });

  it("não repete um contato já chamado hoje", async () => {
    await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Único", telefone: "(11) 92222-0000", tags: [] }),
    );

    const first = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(first).not.toBeNull();

    const second = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(second).toBeNull(); // contato já tem Call hoje → sem próximo
  });
});

// ─── markCallOutcome ──────────────────────────────────────────────────

describe("dialer — markCallOutcome", () => {
  it("atualiza status para answered/no_answer/busy/skip e cria Activity (menos no pular)", async () => {
    const outcomes: DialerOutcome[] = ["answered", "no_answer", "busy", "skip"];
    const expectedStatus: Record<DialerOutcome, string> = {
      answered: "answered",
      no_answer: "no_answer",
      busy: "busy",
      skip: "completed", // outcome "skip" → CallStatus "completed"
      voicemail: "no_answer", // produto §D (efeitos em resultado.test.ts)
      wrong_number: "failed",
    };
    const callIds: string[] = [];

    for (let i = 0; i < outcomes.length; i++) {
      // Um contato novo (com identifier whatsapp) por slot →getNextDialerSlot
      // pega o próximo não-chamado de hoje.
      await runWithTeam(TEAM_D, () =>
        contacts.create({ nome: `Lead ${i}`, telefone: `(11) 9${i}000-0000`, tags: [] }),
      );
      const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
      expect(slot).not.toBeNull();
      callIds.push(slot!.callId);
    }

    for (let i = 0; i < outcomes.length; i++) {
      // callIds[i] e outcomes[i] existem (preenchidos acima), mas o TS estrito
      // enxerga string | undefined → usamos non-null assertion explícita.
      const callId = callIds[i]!;
      const outcome = outcomes[i]!;
      await runWithTeam(TEAM_D, () => markCallOutcome(callId, outcome));
      const call = await basePrisma.call.findUnique({ where: { id: callId } });
      expect(call?.status).toBe(expectedStatus[outcome]);
      expect(call?.outcome).toBe(outcome); // o placar lê daqui
    }

    // Cada ligação feita gera uma Activity de rastreabilidade; o pulo não.
    const acts = await basePrisma.activity.findMany({ where: { teamId: TEAM_D, tipo: "call" } });
    expect(acts).toHaveLength(3);
    expect(acts.map((a) => (a.meta as { outcome?: string }).outcome).sort()).toEqual(["answered", "busy", "no_answer"]);
  });

  it("pular não cria Activity: o resultado fica só na Call", async () => {
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Pulado", telefone: "(11) 94444-0000", tags: [] }),
    );
    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot).not.toBeNull();

    await runWithTeam(TEAM_D, () => markCallOutcome(slot!.callId, "skip", { notes: "sem tempo" }));

    const call = await basePrisma.call.findUnique({ where: { id: slot!.callId } });
    expect(call?.outcome).toBe("skip");
    expect(call?.status).toBe("completed");
    expect(call?.notes).toBe("sem tempo"); // a nota continua indo para a Call
    expect(await basePrisma.activity.count({ where: { teamId: TEAM_D, contactId: c.id, tipo: "call" } })).toBe(0);
  });

  it("lança CallNotFound para callId inválido", async () => {
    await expect(
      runWithTeam(TEAM_D, () => markCallOutcome("id-inexistente", "answered")),
    ).rejects.toThrow(/CallNotFound/);
  });

  it("lança CallValidationError ao marcar uma ligação já finalizada", async () => {
    await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Dup", telefone: "(11) 95555-0000", tags: [] }),
    );
    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot).not.toBeNull();

    await runWithTeam(TEAM_D, () => markCallOutcome(slot!.callId, "answered"));
    // Segunda marcação: a Call já está finalizada (status answered).
    await expect(
      runWithTeam(TEAM_D, () => markCallOutcome(slot!.callId, "no_answer")),
    ).rejects.toThrow(/já foi finalizada/);
  });
});

// ─── Placar do dia ────────────────────────────────────────────────────

const NUM = "+5511977777777";

/** Cria uma ligação de saída do discador direto no banco (seed cross-team). */
async function seedCall(
  teamId: string,
  contactId: string,
  r: {
    status: "scheduled" | "ringing" | "answered" | "no_answer" | "busy" | "failed" | "completed";
    outcome?: DialerOutcome | null;
    durationSeconds?: number | null;
    userId?: string | null;
    createdAt?: Date;
    provider?: string;
  },
) {
  return basePrisma.call.create({
    data: {
      teamId,
      contactId,
      phoneNumber: NUM,
      direction: "outbound",
      provider: r.provider ?? "manual",
      status: r.status,
      outcome: r.outcome ?? null,
      durationSeconds: r.durationSeconds ?? null,
      userId: r.userId ?? null,
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    },
  });
}

describe("dialer — contarPlacar (puro)", () => {
  const linha = (l: Partial<LinhaDoPlacar> & Pick<LinhaDoPlacar, "status">): LinhaDoPlacar => ({
    outcome: null,
    durationSeconds: null,
    ...l,
  });

  it("sem ligações, tudo zero", () => {
    expect(contarPlacar([])).toEqual({
      total: 0,
      answered: 0,
      noAnswer: 0,
      busy: 0,
      skipped: 0,
      remaining: 0,
      avgDurationSec: 0,
    });
  });

  it("pular (status completed) não é atendida nem entra no total", () => {
    const p = contarPlacar([linha({ status: "completed", outcome: "skip" })]);
    expect(p.answered).toBe(0);
    expect(p.total).toBe(0);
    expect(p.skipped).toBe(1);
  });

  it("a sorteada sem resultado só conta em restantes, scheduled ou ringing", () => {
    const p = contarPlacar([linha({ status: "scheduled" }), linha({ status: "ringing" })]);
    expect(p).toMatchObject({ total: 0, answered: 0, skipped: 0, remaining: 2 });
  });

  it("caixa postal conta como não atendida; número errado só entra no total", () => {
    const p = contarPlacar([
      linha({ status: "no_answer", outcome: "voicemail" }),
      linha({ status: "failed", outcome: "wrong_number" }),
      linha({ status: "busy", outcome: "busy" }),
    ]);
    expect(p).toMatchObject({ total: 3, answered: 0, noAnswer: 1, busy: 1, skipped: 0, remaining: 0 });
  });

  it("a duração média usa só as durações informadas", () => {
    const p = contarPlacar([
      linha({ status: "answered", outcome: "answered", durationSeconds: 60 }),
      linha({ status: "answered", outcome: "answered", durationSeconds: 31 }),
      linha({ status: "no_answer", outcome: "no_answer" }),
    ]);
    expect(p.avgDurationSec).toBe(46); // (60 + 31) / 2 = 45,5 → 46
  });
});

// ─── getDialerStats / placarDoDia ──────────────────────────────────────

describe("dialer — placarDoDia e getDialerStats", () => {
  it("4 ligações no dia: total 2, atendidas 1, puladas 1, não atendidas 1, restantes 1", async () => {
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Stats", telefone: "(11) 97777-7777", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", durationSeconds: 60 });
    await seedCall(TEAM_D, c.id, { status: "completed", outcome: "skip" });
    await seedCall(TEAM_D, c.id, { status: "no_answer", outcome: "no_answer" });
    await seedCall(TEAM_D, c.id, { status: "scheduled" }); // sorteada, sem resultado

    const stats = await runWithTeam(TEAM_D, () => placarDoDia());
    expect(stats).toMatchObject({ total: 2, answered: 1, skipped: 1, noAnswer: 1, busy: 0, remaining: 1 });
    expect(stats.avgDurationSec).toBe(60);

    // A sessão e getDialerStats leem a mesma conta.
    expect(await runWithTeam(TEAM_D, () => getDialerStats())).toEqual(stats);
    const s = await runWithTeam(TEAM_D, () => startDialerSession());
    expect(s).toMatchObject({ total: 2, answered: 1, skipped: 1, noAnswer: 1, busy: 0, remaining: 1 });
  });

  it("ocupado, caixa postal e número errado entram no total; só atendeu é atendida", async () => {
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Mix", telefone: "(11) 97777-6666", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", durationSeconds: 90 });
    await seedCall(TEAM_D, c.id, { status: "busy", outcome: "busy" });
    await seedCall(TEAM_D, c.id, { status: "no_answer", outcome: "voicemail" });
    await seedCall(TEAM_D, c.id, { status: "failed", outcome: "wrong_number" });
    await seedCall(TEAM_D, c.id, { status: "completed", outcome: "skip" });
    await seedCall(TEAM_D, c.id, { status: "completed", outcome: "skip" });

    const stats = await runWithTeam(TEAM_D, () => getDialerStats());
    expect(stats).toMatchObject({ total: 4, answered: 1, busy: 1, noAnswer: 1, skipped: 2, remaining: 0 });
  });

  it("pelo fluxo real: pular dá skipped 1 e nenhuma atendida, nem total", async () => {
    await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Fluxo", telefone: "(11) 93333-0000", tags: [] }),
    );
    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot).not.toBeNull();
    // Sorteada, ainda sem resultado: só em restantes.
    expect(await runWithTeam(TEAM_D, () => getDialerStats())).toMatchObject({ total: 0, answered: 0, skipped: 0, remaining: 1 });

    await runWithTeam(TEAM_D, () => markCallOutcome(slot!.callId, "skip"));

    expect(await runWithTeam(TEAM_D, () => getDialerStats())).toMatchObject({
      total: 0,
      answered: 0,
      skipped: 1,
      noAnswer: 0,
      busy: 0,
      remaining: 0,
    });
  });

  it("isola ligações por time (outro time não conta)", async () => {
    // Ligações do TEAM_D.
    const a = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead A", telefone: "(11) 90001-0001", tags: [] }),
    );
    await seedCall(TEAM_D, a.id, { status: "answered", outcome: "answered", durationSeconds: 10 });

    // Ligações de outro time não devem aparecer no stats de TEAM_D.
    const TEAM_OTHER = "00000000-0000-0000-0000-0000000000e6";
    await basePrisma.team.upsert({
      where: { id: TEAM_OTHER },
      update: { name: "Team Other" },
      create: { id: TEAM_OTHER, name: "Team Other" },
    });
    const b = await runWithTeam(TEAM_OTHER, () =>
      contacts.create({ nome: "Lead Other", telefone: "(21) 90002-0002", tags: [] }),
    );
    await seedCall(TEAM_OTHER, b.id, { status: "answered", outcome: "answered", durationSeconds: 90 });
    await seedCall(TEAM_OTHER, b.id, { status: "completed", outcome: "skip" });

    const stats = await runWithTeam(TEAM_D, () => getDialerStats());
    expect(stats.total).toBe(1); // só TEAM_D
    expect(stats.answered).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.avgDurationSec).toBe(10);
  });

  it("o vendedor A não vê o placar do B (mesmo time); o dono vê o do time", async () => {
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Dois", telefone: "(11) 92222-1111", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", userId: "vendedor-a" });
    await seedCall(TEAM_D, c.id, { status: "completed", outcome: "skip", userId: "vendedor-a" });
    await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", userId: "vendedor-b" });
    await seedCall(TEAM_D, c.id, { status: "no_answer", outcome: "no_answer", userId: "vendedor-b" });
    await seedCall(TEAM_D, c.id, { status: "busy", outcome: "busy", userId: "vendedor-b" });
    await seedCall(TEAM_D, c.id, { status: "scheduled", userId: "vendedor-b" });

    const como = (userId: string, role: string) =>
      runWithTeam(TEAM_D, () => getDialerStats(), { userId, role });

    expect(await como("vendedor-a", "member")).toMatchObject({ total: 1, answered: 1, skipped: 1, noAnswer: 0, busy: 0, remaining: 0 });
    expect(await como("vendedor-b", "member")).toMatchObject({ total: 3, answered: 1, skipped: 0, noAnswer: 1, busy: 1, remaining: 1 });
    expect(await como("dono-teste", "owner")).toMatchObject({ total: 4, answered: 2, skipped: 1, noAnswer: 1, busy: 1, remaining: 1 });

    // A sessão (startDialerSession) usa o mesmo escopo.
    const sa = await runWithTeam(TEAM_D, () => startDialerSession(), { userId: "vendedor-a", role: "member" });
    expect(sa).toMatchObject({ total: 1, answered: 1, skipped: 1, remaining: 0 });
  });
});

// ─── O dia segue o fuso do time ────────────────────────────────────────

describe("dialer — o dia é o do fuso do time", () => {
  it("às 22h30 de Brasília a ligação das 19h conta hoje e a de ontem à noite não", async () => {
    // 23/07/2026 22:30 em Brasília = 24/07 01:30 UTC. No fuso do servidor (UTC),
    // o "hoje" já seria 24/07 e a ligação das 19h sumiria do placar.
    vi.setSystemTime(new Date("2026-07-24T01:30:00Z"));
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Noite", telefone: "(11) 91212-3434", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", createdAt: new Date("2026-07-23T22:00:00Z") }); // 19:00 de 23/07
    await seedCall(TEAM_D, c.id, { status: "no_answer", outcome: "no_answer", createdAt: new Date("2026-07-23T03:00:00Z") }); // 00:00 de 23/07, ainda hoje
    await seedCall(TEAM_D, c.id, { status: "busy", outcome: "busy", createdAt: new Date("2026-07-23T02:59:00Z") }); // 23:59 de 22/07, ontem

    const stats = await runWithTeam(TEAM_D, () => getDialerStats());
    expect(stats).toMatchObject({ total: 2, answered: 1, noAnswer: 1, busy: 0 });

    // O id da sessão também é o dia do time, não o do servidor.
    const s = await runWithTeam(TEAM_D, () => startDialerSession());
    expect(s.id).toBe("dialer-2026-07-23");
    expect(s.total).toBe(2);
  });

  it("à 1h da manhã de Brasília a ligação das 23h de ontem não conta hoje", async () => {
    // 23/07/2026 01:00 em Brasília = 04:00 UTC. No fuso do servidor (UTC) a
    // ligação das 23h de ontem (02:00 UTC) cairia no "hoje".
    vi.setSystemTime(new Date("2026-07-23T04:00:00Z"));
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Madrugada", telefone: "(11) 91313-4545", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", createdAt: new Date("2026-07-23T02:00:00Z") }); // 23:00 de 22/07

    expect(await runWithTeam(TEAM_D, () => getDialerStats())).toMatchObject({ total: 0, answered: 0 });
  });

  it("usa o fuso configurado no time, não só o de Brasília", async () => {
    // Tóquio (UTC+9): 24/07 01:00 lá = 23/07 16:00 UTC; o dia começou às 15:00 UTC.
    vi.setSystemTime(new Date("2026-07-23T16:00:00Z"));
    try {
      await runWithTeam(TEAM_D, () => updateTeamConfig({ timezone: "Asia/Tokyo" }));
      const c = await runWithTeam(TEAM_D, () =>
        contacts.create({ nome: "Lead Tóquio", telefone: "(11) 91414-5656", tags: [] }),
      );
      await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", createdAt: new Date("2026-07-23T15:30:00Z") }); // hoje em Tóquio
      await seedCall(TEAM_D, c.id, { status: "answered", outcome: "answered", createdAt: new Date("2026-07-23T14:00:00Z") }); // ontem em Tóquio, hoje em Brasília

      expect(await runWithTeam(TEAM_D, () => getDialerStats())).toMatchObject({ total: 1, answered: 1 });
      expect((await runWithTeam(TEAM_D, () => startDialerSession())).id).toBe("dialer-2026-07-24");
    } finally {
      // Limpa o cache de 5 min da config deste time.
      await runWithTeam(TEAM_D, () => updateTeamConfig({ timezone: DEFAULT_TZ }));
    }
  });

  it("getNextDialerSlot: o contato ligado ontem à noite (Brasília) volta à fila hoje", async () => {
    // 23/07/2026 01:00 em Brasília = 04:00 UTC; a ligação das 23h de ontem
    // (02:00 UTC) não é de hoje.
    vi.setSystemTime(new Date("2026-07-23T04:00:00Z"));
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Ontem", telefone: "(11) 91515-6767", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "no_answer", outcome: "no_answer", createdAt: new Date("2026-07-23T02:00:00Z") });

    const slot = await runWithTeam(TEAM_D, () => getNextDialerSlot());
    expect(slot?.contactId).toBe(c.id);
  });

  it("getNextDialerSlot: o contato ligado hoje (Brasília) não volta, mesmo já sendo o dia seguinte em UTC", async () => {
    // 22:30 de 23/07 em Brasília = 01:30 UTC de 24/07; ligado às 19h (22:00 UTC).
    vi.setSystemTime(new Date("2026-07-24T01:30:00Z"));
    const c = await runWithTeam(TEAM_D, () =>
      contacts.create({ nome: "Lead Hoje", telefone: "(11) 91616-7878", tags: [] }),
    );
    await seedCall(TEAM_D, c.id, { status: "no_answer", outcome: "no_answer", createdAt: new Date("2026-07-23T22:00:00Z") });

    expect(await runWithTeam(TEAM_D, () => getNextDialerSlot())).toBeNull();
  });
});
