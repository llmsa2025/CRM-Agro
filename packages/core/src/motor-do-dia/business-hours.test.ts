import { describe, it, expect } from "vitest";
import { isBusinessHour, canCallNow, getNextCallSlot } from "./business-hours";
import type { BusinessHoursOptions } from "./business-hours";

// Offset explícito -03:00 (America/Sao_Paulo) → instante independe do fuso do CI.
const sp = (iso: string) => new Date(`${iso}-03:00`);

// Config com o gate LIGADO e os defaults do TeamConfig (seg–sex 08:00–18:00,
// respeitando feriados). Espelha o que `getTeamConfig` devolve quando o time
// habilita o horário comercial sem customizar nada.
const ON: BusinessHoursOptions = { respectBusinessHours: true };

describe("business-hours — isBusinessHour (gate on)", () => {
  it("segunda 10h → true", () => {
    expect(isBusinessHour(sp("2026-07-20T10:00:00"), ON)).toBe(true);
  });

  it("domingo 10h → false", () => {
    expect(isBusinessHour(sp("2026-07-19T10:00:00"), ON)).toBe(false);
  });

  it("sábado 10h → false (sábado fora dos dias úteis default seg–sex)", () => {
    expect(isBusinessHour(sp("2026-07-18T10:00:00"), ON)).toBe(false);
  });

  it("segunda 18h → false (fechamento exclusivo)", () => {
    expect(isBusinessHour(sp("2026-07-20T18:00:00"), ON)).toBe(false);
  });
});

describe("business-hours — isBusinessHour (gate off)", () => {
  it("sem respectBusinessHours → sempre true (domingo de madrugada)", () => {
    expect(isBusinessHour(sp("2026-07-19T03:00:00"))).toBe(true);
  });

  it("respectBusinessHours=false → true mesmo em feriado/fora de hora", () => {
    expect(
      isBusinessHour(sp("2025-12-25T23:00:00"), { respectBusinessHours: false }),
    ).toBe(true);
  });
});

describe("business-hours — isBusinessHour (dias/horários custom)", () => {
  it("sábado incluído em businessDays → true dentro do expediente", () => {
    expect(
      isBusinessHour(sp("2026-07-18T10:00:00"), {
        ...ON,
        businessDays: "mon,tue,wed,thu,fri,sat",
      }),
    ).toBe(true);
  });

  it("fechamento custom (12:00) → sábado 14h false", () => {
    expect(
      isBusinessHour(sp("2026-07-18T14:00:00"), {
        ...ON,
        businessDays: "mon,tue,wed,thu,fri,sat",
        businessHourEnd: "12:00",
      }),
    ).toBe(false);
  });
});

describe("business-hours — canCallNow", () => {
  it("feriado em horário comercial → false", () => {
    // 25/12/2025 (Natal) é quinta 10h: seria hora comercial, mas é feriado.
    expect(isBusinessHour(sp("2025-12-25T10:00:00"), ON)).toBe(true);
    expect(canCallNow(sp("2025-12-25T10:00:00"), ON)).toBe(false);
  });

  it("respectHolidays=false ignora feriado em horário comercial → true", () => {
    expect(
      canCallNow(sp("2025-12-25T10:00:00"), { ...ON, respectHolidays: false }),
    ).toBe(true);
  });

  it("dia útil em horário comercial e não feriado → true", () => {
    expect(canCallNow(sp("2026-07-20T10:00:00"), ON)).toBe(true);
  });

  it("respectBusinessHours ausente → true sempre (feriado de madrugada)", () => {
    expect(canCallNow(sp("2025-12-25T03:00:00"))).toBe(true);
  });

  it("respectBusinessHours=false → true mesmo fora de hora", () => {
    expect(
      canCallNow(sp("2026-07-19T03:00:00"), { respectBusinessHours: false }),
    ).toBe(true);
  });
});

describe("business-hours — getNextCallSlot", () => {
  it("dentro da janela devolve o próprio instante", () => {
    const now = sp("2026-07-20T10:00:00");
    expect(getNextCallSlot(now, ON).getTime()).toBe(now.getTime());
  });

  it("antes de abrir pula para 08:00 do mesmo dia", () => {
    const slot = getNextCallSlot(sp("2026-07-20T06:00:00"), ON);
    expect(slot.getTime()).toBe(sp("2026-07-20T08:00:00").getTime());
  });

  it("após o expediente na sexta pula para segunda 08:00 (fim de semana fora)", () => {
    // Sexta 20h → sábado (fora dos dias úteis) e domingo → segunda 08:00.
    const slot = getNextCallSlot(sp("2026-07-24T20:00:00"), ON);
    expect(slot.getTime()).toBe(sp("2026-07-27T08:00:00").getTime());
  });

  it("sábado à tarde pula para segunda 08:00 (pula domingo)", () => {
    const slot = getNextCallSlot(sp("2026-07-25T14:00:00"), ON);
    expect(slot.getTime()).toBe(sp("2026-07-27T08:00:00").getTime());
  });

  it("pula feriado para o próximo dia útil", () => {
    // 25/12/2025 (Natal, quinta) → 26/12 (sexta) 08:00.
    const slot = getNextCallSlot(sp("2025-12-25T09:00:00"), ON);
    expect(slot.getTime()).toBe(sp("2025-12-26T08:00:00").getTime());
  });

  it("respectHolidays=false não pula feriado (devolve o próprio instante na janela)", () => {
    const now = sp("2025-12-25T09:00:00");
    expect(
      getNextCallSlot(now, { respectBusinessHours: true, respectHolidays: false }).getTime(),
    ).toBe(now.getTime());
  });

  it("respectBusinessHours ausente devolve o próprio instante", () => {
    const now = sp("2026-07-19T03:00:00"); // domingo de madrugada
    expect(getNextCallSlot(now).getTime()).toBe(now.getTime());
  });
});
