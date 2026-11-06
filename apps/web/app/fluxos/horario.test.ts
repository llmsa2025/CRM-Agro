import { describe, expect, it } from "vitest";
import { alternarDia, erroDoHorario, horarioPadraoDoFluxoNovo, rotuloCurtoDoHorario, trocarModo } from "./horario";

describe("horário de envio do fluxo (tela)", () => {
  it("fluxo novo já vem com seg a sex, 08:00 às 18:00 e feriados fora", () => {
    const j = horarioPadraoDoFluxoNovo();
    expect(j).toEqual({ modo: "propria", abertura: "08:00", fechamento: "18:00", dias: ["mon", "tue", "wed", "thu", "fri"], feriados: true });
    expect(erroDoHorario(j)).toBeNull();
  });

  it("cada chamada devolve um objeto novo (editar um não muda o padrão)", () => {
    const a = horarioPadraoDoFluxoNovo();
    a.dias.push("sat");
    expect(horarioPadraoDoFluxoNovo().dias).not.toContain("sat");
  });

  it("avisa de fechamento antes da abertura, sem dia e hora vazia", () => {
    const base = horarioPadraoDoFluxoNovo();
    expect(erroDoHorario({ ...base, abertura: "18:00", fechamento: "08:00" })).toMatch(/depois da abertura/);
    expect(erroDoHorario({ ...base, abertura: "09:00", fechamento: "09:00" })).toMatch(/depois da abertura/);
    expect(erroDoHorario({ ...base, dias: [] })).toMatch(/ao menos um dia/);
    expect(erroDoHorario({ ...base, abertura: "" })).toMatch(/abertura e o fechamento/);
  });

  it("empresa e livre nunca dão erro de horário", () => {
    expect(erroDoHorario({ modo: "empresa" })).toBeNull();
    expect(erroDoHorario({ modo: "livre" })).toBeNull();
  });

  it("marcar e desmarcar dia mantém a ordem da semana", () => {
    const base = horarioPadraoDoFluxoNovo();
    const comSabado = alternarDia(base, "sat", true);
    expect(comSabado.dias).toEqual(["mon", "tue", "wed", "thu", "fri", "sat"]);
    const comDomingo = alternarDia(comSabado, "sun", true);
    expect(comDomingo.dias[0]).toBe("sun");
    expect(alternarDia(comDomingo, "wed", false).dias).not.toContain("wed");
  });

  it("trocar de modo e voltar não perde o horário que a pessoa montou", () => {
    const meu = { ...horarioPadraoDoFluxoNovo(), abertura: "10:00", fechamento: "16:00" };
    const livre = trocarModo(meu, "livre", meu);
    expect(livre).toEqual({ modo: "livre" });
    expect(trocarModo(livre, "propria", meu)).toEqual(meu);
    expect(trocarModo(meu, "propria", meu)).toBe(meu);
  });

  it("rótulo curto do gatilho", () => {
    expect(rotuloCurtoDoHorario({ modo: "livre" })).toBe("Envia a qualquer hora");
    expect(rotuloCurtoDoHorario({ modo: "empresa" })).toBe("Horário da empresa");
    expect(rotuloCurtoDoHorario(horarioPadraoDoFluxoNovo())).toBe("Envia das 08:00 às 18:00");
  });
});
