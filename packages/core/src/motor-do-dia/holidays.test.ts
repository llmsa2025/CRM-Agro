import { describe, it, expect } from "vitest";
import { isHoliday, getNextHoliday, getHolidays } from "./holidays";

// Datas construídas com offset explícito -03:00 (America/Sao_Paulo) para o
// instante independer do fuso do ambiente de teste.
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe("holidays — feriados fixos", () => {
  it("01/01 (Confraternização) é feriado", () => {
    expect(isHoliday(sp("2026-01-01T10:00:00"))).toBe(true);
  });

  it("25/12 (Natal) é feriado", () => {
    expect(isHoliday(sp("2025-12-25T09:00:00"))).toBe(true);
  });
});

describe("holidays — feriados móveis", () => {
  it("Carnaval de 2026 cai em 17/02/2026", () => {
    expect(isHoliday(sp("2026-02-17T12:00:00"))).toBe(true);
    const carnaval = getHolidays(2026).find((h) => h.name === "Carnaval");
    expect(carnaval).toBeDefined();
    expect(carnaval!.date.getUTCFullYear()).toBe(2026);
    expect(carnaval!.date.getUTCMonth() + 1).toBe(2);
    expect(carnaval!.date.getUTCDate()).toBe(17);
  });
});

describe("holidays — dia normal", () => {
  it("um dia útil comum não é feriado", () => {
    expect(isHoliday(sp("2026-07-20T10:00:00"))).toBe(false);
  });
});

describe("holidays — getNextHoliday", () => {
  it("devolve o próximo feriado a partir da data", () => {
    // 20/07/2026 (segunda comum) → próximo é 07/09 (Independência).
    const next = getNextHoliday(sp("2026-07-20T10:00:00"));
    expect(next.name).toBe("Independência do Brasil");
    expect(next.date.getUTCMonth() + 1).toBe(9);
    expect(next.date.getUTCDate()).toBe(7);
  });

  it("vira o ano quando não há mais feriados no ano corrente", () => {
    // 26/12/2026 → próximo é 01/01/2027.
    const next = getNextHoliday(sp("2026-12-26T10:00:00"));
    expect(next.date.getUTCFullYear()).toBe(2027);
    expect(next.date.getUTCMonth() + 1).toBe(1);
    expect(next.date.getUTCDate()).toBe(1);
  });
});

describe("20/11 — Consciência Negra (Lei 14.759/2023)", () => {
  it("é feriado a partir de 2024", () => {
    expect(isHoliday(sp("2026-11-20T10:00:00"))).toBe(true);
    expect(isHoliday(sp("2024-11-20T10:00:00"))).toBe(true);
    expect(getHolidays(2026).some((h) => h.name.includes("Consciência Negra"))).toBe(true);
  });

  it("antes da lei não era feriado nacional", () => {
    expect(isHoliday(sp("2023-11-20T10:00:00"))).toBe(false);
    expect(getHolidays(2023).some((h) => h.name.includes("Consciência Negra"))).toBe(false);
  });
});

