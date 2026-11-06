import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import {
  getTeamConfig,
  updateTeamConfig,
  DEFAULT_TEAM_CONFIG,
  teamConfigSchema,
  teamConfigUpdateSchema,
  toBusinessHoursOptions,
} from "./team-config";
import { isBusinessHour } from "./business-hours";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000f7", "00000000-0000-0000-0000-0000000000f8"];

// Times de teste (hex válido). DEV_TEAM_ID (000...001) é do seed — usamos
// outros para nunca colidir com dados da base.
const TEAM_F1 = "00000000-0000-0000-0000-0000000000f7";
const TEAM_F2 = "00000000-0000-0000-0000-0000000000f8";

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_F1, "Team F1 (team-config)"],
    [TEAM_F2, "Team F2 (team-config)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  // Só este módulo escreve em TeamConfig; limpa tudo entre testes.
  await basePrisma.teamConfig.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

describe("team-config — getTeamConfig", () => {
  it("retorna defaults quando não há row (não trava o discador)", async () => {
    const cfg = await runWithTeam(TEAM_F1, () => getTeamConfig());
    expect(cfg).toEqual(DEFAULT_TEAM_CONFIG);
    expect(cfg.respectBusinessHours).toBe(false);
  });
});

describe("team-config — updateTeamConfig", () => {
  it("cria a row quando não existe (defaults do banco complementam)", async () => {
    const cfg = await runWithTeam(TEAM_F1, () =>
      updateTeamConfig({ respectBusinessHours: true }),
    );
    expect(cfg.respectBusinessHours).toBe(true);
    // Campos omitidos pegam defaults do DB (espelham DEFAULT_TEAM_CONFIG).
    expect(cfg.businessHourStart).toBe("08:00");
    expect(cfg.businessHourEnd).toBe("18:00");
    expect(cfg.businessDays).toBe("mon,tue,wed,thu,fri");
    expect(cfg.respectHolidays).toBe(true);
    expect(cfg.timezone).toBe("America/Sao_Paulo");

    const reload = await runWithTeam(TEAM_F1, () => getTeamConfig());
    expect(reload).toEqual(cfg);
  });

  it("atualiza a row existente preservando campos omitidos", async () => {
    await runWithTeam(TEAM_F1, () => updateTeamConfig({ respectBusinessHours: true }));

    const cfg = await runWithTeam(TEAM_F1, () =>
      updateTeamConfig({ businessHourStart: "09:00" }),
    );
    expect(cfg.respectBusinessHours).toBe(true); // preservado
    expect(cfg.businessHourStart).toBe("09:00");
    expect(cfg.businessHourEnd).toBe("18:00"); // preservado
  });

  it("salva config completa (horários, dias, feriados, fuso)", async () => {
    const cfg = await runWithTeam(TEAM_F1, () =>
      updateTeamConfig({
        respectBusinessHours: true,
        businessHourStart: "09:00",
        businessHourEnd: "17:30",
        businessDays: "mon,tue,wed,thu",
        respectHolidays: false,
        timezone: "America/New_York",
      }),
    );
    expect(cfg).toEqual({
      respectBusinessHours: true,
      businessHourStart: "09:00",
      businessHourEnd: "17:30",
      businessDays: "mon,tue,wed,thu",
      respectHolidays: false,
      timezone: "America/New_York",
    });
  });

  it("isola config por time (config do F1 não vaza pro F2)", async () => {
    await runWithTeam(TEAM_F1, () => updateTeamConfig({ respectBusinessHours: true }));

    const f2 = await runWithTeam(TEAM_F2, () => getTeamConfig());
    expect(f2.respectBusinessHours).toBe(false); // defaults, não vê a row do F1
  });
});

describe("team-config — toBusinessHoursOptions", () => {
  it("mapeia timezone → timeZone e repassa os flags/janela", () => {
    const opts = toBusinessHoursOptions({
      respectBusinessHours: true,
      businessHourStart: "09:00",
      businessHourEnd: "17:30",
      businessDays: "mon,tue",
      respectHolidays: false,
      timezone: "America/New_York",
    });
    expect(opts).toEqual({
      timeZone: "America/New_York",
      respectBusinessHours: true,
      businessHourStart: "09:00",
      businessHourEnd: "17:30",
      businessDays: "mon,tue",
      respectHolidays: false,
    });
  });

  it("a config mapeada é respeitada por isBusinessHour", () => {
    // Domingo 10h em NY: domingo fora de "mon,tue" → false.
    const opts = toBusinessHoursOptions({
      respectBusinessHours: true,
      businessHourStart: "08:00",
      businessHourEnd: "18:00",
      businessDays: "mon,tue",
      respectHolidays: true,
      timezone: "America/New_York",
    });
    // 2026-07-19 é domingo; 14:00 UTC = 10:00 EDT.
    expect(isBusinessHour(new Date("2026-07-19T14:00:00Z"), opts)).toBe(false);
  });
});

describe("team-config — zod schema", () => {
  const valid = {
    respectBusinessHours: true,
    businessHourStart: "08:00",
    businessHourEnd: "18:00",
    businessDays: "mon,tue,wed,thu,fri",
    respectHolidays: true,
    timezone: "America/Sao_Paulo",
  };

  it("aceita config válida", () => {
    expect(() => teamConfigSchema.parse(valid)).not.toThrow();
  });

  it("rejeita horário fora de HH:mm", () => {
    expect(() => teamConfigSchema.parse({ ...valid, businessHourStart: "8:00" })).toThrow();
  });

  it("rejeita fechamento <= abertura", () => {
    expect(() =>
      teamConfigSchema.parse({ ...valid, businessHourStart: "18:00", businessHourEnd: "18:00" }),
    ).toThrow();
    expect(() =>
      teamConfigSchema.parse({ ...valid, businessHourStart: "19:00", businessHourEnd: "08:00" }),
    ).toThrow();
  });

  it("rejeita dias inválidos", () => {
    expect(() => teamConfigSchema.parse({ ...valid, businessDays: "seg,ter,qua" })).toThrow();
  });

  it("rejeita fuso inválido", () => {
    expect(() => teamConfigSchema.parse({ ...valid, timezone: "Foo/Bar" })).toThrow();
  });

  it("update (partial) aceita só alguns campos", () => {
    expect(teamConfigUpdateSchema.parse({ respectBusinessHours: true }).respectBusinessHours).toBe(true);
    expect(teamConfigUpdateSchema.parse({ businessHourStart: "09:30" }).businessHourStart).toBe("09:30");
  });

  it("update rejeita start>=end quando ambos vêm juntos", () => {
    expect(() =>
      teamConfigUpdateSchema.parse({ businessHourStart: "18:00", businessHourEnd: "18:00" }),
    ).toThrow();
  });
});
