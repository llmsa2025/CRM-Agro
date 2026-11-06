import { describe, expect, it } from "vitest";
import { JANELA_DA_EMPRESA, JANELA_PROPRIA_PADRAO, janelaEnvioSchema, lerJanelaEnvio, resumoDoHorarioDaEmpresa, resumoDosDias } from "./janela";

describe("horário de envio do fluxo (schema)", () => {
  it("aceita os três modos", () => {
    expect(janelaEnvioSchema.safeParse({ modo: "empresa" }).success).toBe(true);
    expect(janelaEnvioSchema.safeParse({ modo: "livre" }).success).toBe(true);
    expect(janelaEnvioSchema.safeParse(JANELA_PROPRIA_PADRAO).success).toBe(true);
  });

  it("o horário próprio exige HH:mm, abertura antes do fechamento e ao menos um dia", () => {
    const base = { modo: "propria", abertura: "08:00", fechamento: "18:00", dias: ["mon"], feriados: true };
    expect(janelaEnvioSchema.safeParse({ ...base, abertura: "8:00" }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ ...base, abertura: "25:00" }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ ...base, fechamento: "08:00" }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ ...base, abertura: "18:00", fechamento: "09:00" }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ ...base, dias: [] }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ ...base, dias: ["segunda"] }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ ...base, feriados: "sim" }).success).toBe(false);
    expect(janelaEnvioSchema.safeParse({ modo: "quando-quiser" }).success).toBe(false);
  });
});

describe("lerJanelaEnvio (tolerante)", () => {
  it("sem nada salvo, ou com valor torto, segue a empresa", () => {
    expect(lerJanelaEnvio(null)).toEqual(JANELA_DA_EMPRESA);
    expect(lerJanelaEnvio(undefined)).toEqual(JANELA_DA_EMPRESA);
    expect(lerJanelaEnvio("texto")).toEqual(JANELA_DA_EMPRESA);
    expect(lerJanelaEnvio({})).toEqual(JANELA_DA_EMPRESA);
    expect(lerJanelaEnvio({ janelaEnvio: { modo: "propria", abertura: "x" } })).toEqual(JANELA_DA_EMPRESA);
    expect(lerJanelaEnvio({ tagId: "t1", reentry: "never" })).toEqual(JANELA_DA_EMPRESA);
  });

  it("devolve o que está salvo quando vale", () => {
    expect(lerJanelaEnvio({ janelaEnvio: { modo: "livre" }, tagId: "t1" })).toEqual({ modo: "livre" });
    expect(lerJanelaEnvio({ janelaEnvio: JANELA_PROPRIA_PADRAO })).toEqual(JANELA_PROPRIA_PADRAO);
  });
});

describe("textos do horário", () => {
  it("resumo dos dias", () => {
    expect(resumoDosDias(["mon", "tue", "wed", "thu", "fri"])).toBe("seg a sex");
    expect(resumoDosDias(["fri", "mon", "tue", "wed", "thu"])).toBe("seg a sex"); // ordem de entrada não importa
    expect(resumoDosDias(["mon", "wed", "fri"])).toBe("seg, qua e sex");
    expect(resumoDosDias(["sat"])).toBe("sáb");
    expect(resumoDosDias(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).toBe("todos os dias");
    expect(resumoDosDias([])).toBe("nenhum dia");
    expect(resumoDosDias(["mon", "tue"])).toBe("seg e ter");
  });

  it("resumo do horário da empresa: desligado diz que não há restrição", () => {
    const base = { respectBusinessHours: false, businessHourStart: "08:00", businessHourEnd: "18:00", businessDays: "mon,tue,wed,thu,fri", respectHolidays: true };
    expect(resumoDoHorarioDaEmpresa(base)).toContain("sem restrição de horário");
    expect(resumoDoHorarioDaEmpresa({ ...base, respectBusinessHours: true })).toBe("seg a sex, das 08:00 às 18:00, sem feriados");
    expect(resumoDoHorarioDaEmpresa({ ...base, respectBusinessHours: true, respectHolidays: false })).toBe("seg a sex, das 08:00 às 18:00");
  });

  it("nenhum texto usa travessão", () => {
    const t = [resumoDosDias(["mon", "wed"]), resumoDoHorarioDaEmpresa({ respectBusinessHours: true, businessHourStart: "08:00", businessHourEnd: "18:00", businessDays: "mon,sat", respectHolidays: true })];
    for (const x of t) expect(x).not.toMatch(/[—–]/);
  });
});
