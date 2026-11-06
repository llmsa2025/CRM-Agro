import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { semearToques } from "../test-support/toque-cenario";
import * as contacts from "../contacts/index";
import { calcRemainingTouches, calcPriority, currentPeriodo } from "./touch-budget";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000c3", "00000000-0000-0000-0000-0000000000d4"];

// Times de teste (hex válido). DEV_TEAM_ID (000...001) é do seed — usamos outros.
const TEAM_A = "00000000-0000-0000-0000-0000000000c3";
const TEAM_B = "00000000-0000-0000-0000-0000000000d4";

const DAY = 86_400_000;

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (motor)"],
    [TEAM_B, "Team B (motor)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.goal.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

/** Cria uma Activity de toque no team, com createdAt controlado. */
async function seedTouch(teamId: string, contactId: string, createdAt: Date) {
  await basePrisma.activity.create({
    data: { teamId, contactId, tipo: "whatsapp", direcao: "out", createdAt },
  });
}

describe("touch-budget — calcRemainingTouches", () => {
  it("calcula meta, feitos, restantes e progresso a partir do Goal do período", async () => {
    const contact = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Lead", tags: [] }));

    // Meta diária do período atual = 10 toques.
    await basePrisma.goal.create({
      data: { teamId: TEAM_A, periodo: currentPeriodo(), metaValor: 5000, toquesPorDia: 10 },
    });

    // 3 toques hoje.
    for (let i = 0; i < 3; i++) await seedTouch(TEAM_A, contact.id, new Date());

    const budget = await runWithTeam(TEAM_A, () => calcRemainingTouches());
    expect(budget.meta).toBe(10);
    expect(budget.feitos).toBe(3);
    expect(budget.restantes).toBe(7);
    expect(budget.progresso).toBe(30);
  });

  it("sem meta cadastrada → meta 0, restantes 0, progresso 0", async () => {
    const budget = await runWithTeam(TEAM_A, () => calcRemainingTouches());
    expect(budget).toEqual({ meta: 0, feitos: 0, restantes: 0, progresso: 0 });
  });

  it("isolamento por time: toques de outro time não contam", async () => {
    const a = await runWithTeam(TEAM_A, () => contacts.create({ nome: "A", tags: [] }));
    const b = await runWithTeam(TEAM_B, () => contacts.create({ nome: "B", tags: [] }));
    await basePrisma.goal.create({
      data: { teamId: TEAM_A, periodo: currentPeriodo(), metaValor: 1000, toquesPorDia: 8 },
    });
    await seedTouch(TEAM_A, a.id, new Date());
    await seedTouch(TEAM_B, b.id, new Date());

    const budget = await runWithTeam(TEAM_A, () => calcRemainingTouches());
    expect(budget.feitos).toBe(1);
  });
});

describe("touch-budget — calcPriority", () => {
  it("sem nenhum toque → alta", async () => {
    const c = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Sem toque", tags: [] }));
    const p = await runWithTeam(TEAM_A, () => calcPriority(c.id));
    expect(p).toBe("alta");
  });

  it("último toque há mais de 3 dias → alta", async () => {
    const c = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Frio", tags: [] }));
    await seedTouch(TEAM_A, c.id, new Date(Date.now() - 5 * DAY));
    const p = await runWithTeam(TEAM_A, () => calcPriority(c.id));
    expect(p).toBe("alta");
  });

  it("último toque de 1 a 3 dias → média", async () => {
    const c = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Morno", tags: [] }));
    await seedTouch(TEAM_A, c.id, new Date(Date.now() - 2 * DAY));
    const p = await runWithTeam(TEAM_A, () => calcPriority(c.id));
    expect(p).toBe("media");
  });

  it("último toque hoje → baixa", async () => {
    const c = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Quente", tags: [] }));
    await seedTouch(TEAM_A, c.id, new Date());
    const p = await runWithTeam(TEAM_A, () => calcPriority(c.id));
    expect(p).toBe("baixa");
  });

  it("usa o toque mais recente quando há vários", async () => {
    const c = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Vários", tags: [] }));
    await seedTouch(TEAM_A, c.id, new Date(Date.now() - 10 * DAY));
    await seedTouch(TEAM_A, c.id, new Date()); // mais recente = hoje
    const p = await runWithTeam(TEAM_A, () => calcPriority(c.id));
    expect(p).toBe("baixa");
  });
});

describe("touch-budget: fonte única do toque (F1A-03)", () => {
  // Cenário de aceite (test-support/toque-cenario.ts): ligação declarada, ligação comprovada, WhatsApp recebido,
  // anotação de ligação fora do CRM Agro, nota comum, ligação sem direção e um contato sem nada.
  it("o orçamento do dia conta 1 ligação: só a comprovada; a declarada, a anotação e a mensagem recebida ficam de fora", async () => {
    await basePrisma.goal.create({ data: { teamId: TEAM_A, periodo: currentPeriodo(), metaValor: 5000, toquesPorDia: 10 } });
    await semearToques(basePrisma, TEAM_A);

    const budget = await runWithTeam(TEAM_A, () => calcRemainingTouches());
    expect(budget).toEqual({ meta: 10, feitos: 1, restantes: 9, progresso: 10 });
  });

  it("calcPriority: a abordagem declarada, a comprovada e a anotada dão baixa; entrada, nota comum e ligação sem direção não", async () => {
    const c = await semearToques(basePrisma, TEAM_A);
    const prioridade = (id: string) => runWithTeam(TEAM_A, () => calcPriority(id));

    expect(await prioridade(c.declarada)).toBe("baixa");
    expect(await prioridade(c.comprovada)).toBe("baixa");
    expect(await prioridade(c.anotada)).toBe("baixa");
    expect(await prioridade(c.entrada)).toBe("alta");
    expect(await prioridade(c.notaComum)).toBe("alta");
    expect(await prioridade(c.direcaoNula)).toBe("alta");
    expect(await prioridade(c.semNada)).toBe("alta");
  });

  it("a anotação antiga (há 5 dias) volta a ser prioridade alta, como qualquer outra abordagem", async () => {
    const c = await runWithTeam(TEAM_A, () => contacts.create({ nome: "Anotou faz tempo", tags: [] }));
    await basePrisma.activity.create({
      data: { teamId: TEAM_A, contactId: c.id, tipo: "note", meta: { ligacaoForaDoCrmAgro: true }, createdAt: new Date(Date.now() - 5 * DAY) },
    });
    expect(await runWithTeam(TEAM_A, () => calcPriority(c.id))).toBe("alta");
  });

  it("dois times: o orçamento e a prioridade de um não enxergam o outro", async () => {
    await basePrisma.goal.createMany({
      data: [TEAM_A, TEAM_B].map((teamId) => ({ teamId, periodo: currentPeriodo(), metaValor: 1000, toquesPorDia: 10 })),
    });
    const a = await semearToques(basePrisma, TEAM_A);
    const b = await semearToques(basePrisma, TEAM_B);
    // O time B ainda faz mais 2 ligações comprovadas.
    await basePrisma.activity.createMany({
      data: [1, 2].map(() => ({ teamId: TEAM_B, contactId: b.semNada, tipo: "call" as const, direcao: "out" as const, meta: { comprovada: true } })),
    });

    expect((await runWithTeam(TEAM_A, () => calcRemainingTouches())).feitos).toBe(1);
    expect((await runWithTeam(TEAM_B, () => calcRemainingTouches())).feitos).toBe(3);
    // O contato do time A não existe para o B: sem abordagem visível, cai em "alta".
    expect(await runWithTeam(TEAM_B, () => calcPriority(a.declarada))).toBe("alta");
    expect(await runWithTeam(TEAM_A, () => calcPriority(a.declarada))).toBe("baixa");
  });
});
