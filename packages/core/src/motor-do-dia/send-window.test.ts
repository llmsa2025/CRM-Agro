import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { proximoSlotDeEnvio, adiamentoForaDaJanela, adiamentoParaProximoDia, configDaJanela, JITTER_ABERTURA_MIN } from "./send-window";
import { DEFAULT_TEAM_CONFIG, updateTeamConfig } from "./team-config";
import { jitterDelayMs, JITTER_LOTE_PADRAO_MIN } from "../flows/triggers";
import type { JanelaEnvio } from "../flows/janela";

/**
 * Janela de envio do motor (item 1.3 — MF-05/MF-06). Horários em São Paulo
 * (-03:00). 2026-11-20 é sexta-feira e feriado (Consciência Negra).
 */
const sp = (iso: string) => new Date(`${iso}-03:00`);
const TEAM = "00000000-0000-0000-0000-0000000000c5";
const DONO = { userId: "dono", role: "owner" };

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Janela (test)" } });
});

beforeEach(async () => {
  process.env.FLOW_JANELA_ENVIO = "on";
  await basePrisma.teamConfig.deleteMany({ where: { teamId: TEAM } });
});

afterEach(() => {
  process.env.FLOW_JANELA_ENVIO = "off";
  vi.useRealTimers();
});

describe("proximoSlotDeEnvio (padrão seg–sex 08–18, feriados)", () => {
  const cfg = DEFAULT_TEAM_CONFIG;
  it("dentro da janela: agora mesmo", () => {
    const t = sp("2026-09-29T10:00:00"); // terça
    expect(proximoSlotDeEnvio(t, cfg)).toEqual(t);
  });
  it("sexta 20h → segunda 08:00", () => {
    expect(proximoSlotDeEnvio(sp("2026-10-02T20:00:00"), cfg)).toEqual(sp("2026-10-05T08:00:00"));
  });
  it("sábado → segunda 08:00", () => {
    expect(proximoSlotDeEnvio(sp("2026-09-26T02:00:00"), cfg)).toEqual(sp("2026-09-28T08:00:00"));
  });
  it("madrugada de dia útil → 08:00 do mesmo dia", () => {
    expect(proximoSlotDeEnvio(sp("2026-09-29T03:10:00"), cfg)).toEqual(sp("2026-09-29T08:00:00"));
  });
  it("feriado 20/11/2026 (sexta) → segunda 23/11 08:00", () => {
    expect(proximoSlotDeEnvio(sp("2026-11-20T10:00:00"), cfg)).toEqual(sp("2026-11-23T08:00:00"));
  });
});

describe("adiamentos com a config do time", () => {
  const ligar = () => runWithTeam(TEAM, () => updateTeamConfig({ respectBusinessHours: true }), DONO);

  it("fora da janela: até a abertura + jitter de no máximo 90 min; dentro: null", async () => {
    await ligar();
    vi.useFakeTimers({ toFake: ["Date"] });
    const sabado = sp("2026-09-26T02:00:00");
    vi.setSystemTime(sabado);
    const d = await runWithTeam(TEAM, () => adiamentoForaDaJanela(sabado), DONO);
    const abertura = sp("2026-09-28T08:00:00").getTime() - sabado.getTime();
    expect(d).toBeGreaterThanOrEqual(abertura);
    expect(d!).toBeLessThanOrEqual(abertura + JITTER_ABERTURA_MIN * 60_000);

    const terca = sp("2026-09-29T10:00:00");
    expect(await runWithTeam(TEAM, () => adiamentoForaDaJanela(terca), DONO)).toBeNull();
  });

  it("respeita a config salva do time (ex.: sábado de manhã liberado)", async () => {
    await runWithTeam(TEAM, () => updateTeamConfig({ respectBusinessHours: true, businessDays: "mon,tue,wed,thu,fri,sat", businessHourStart: "07:00" }), DONO);
    const sabado9h = sp("2026-09-26T09:00:00");
    expect(await runWithTeam(TEAM, () => adiamentoForaDaJanela(sabado9h), DONO)).toBeNull();
  });

  it("cota esgotada/pausa: próximo dia útil na ABERTURA + jitter — nunca 00:00", async () => {
    const sexta17h = sp("2026-10-02T17:00:00");
    const d = await runWithTeam(TEAM, () => adiamentoParaProximoDia(sexta17h), DONO);
    const alvo = new Date(sexta17h.getTime() + d);
    expect(alvo.getTime()).toBeGreaterThanOrEqual(sp("2026-10-05T08:00:00").getTime());
    expect(alvo.getTime()).toBeLessThanOrEqual(sp("2026-10-05T09:30:00").getTime());
  });

  it("interruptor FLOW_JANELA_ENVIO=off libera sempre", async () => {
    await ligar();
    process.env.FLOW_JANELA_ENVIO = "off";
    expect(await runWithTeam(TEAM, () => adiamentoForaDaJanela(sp("2026-09-26T02:00:00")), DONO)).toBeNull();
  });
});

describe("horário de envio do FLUXO (configDaJanela)", () => {
  const empresaLigada = { ...DEFAULT_TEAM_CONFIG, respectBusinessHours: true };
  const propria: JanelaEnvio = { modo: "propria", abertura: "10:00", fechamento: "12:00", dias: ["mon", "wed"], feriados: false };

  it("'empresa' segue o botão da empresa: desligado = sem restrição; ligado = a config dela", () => {
    expect(configDaJanela(DEFAULT_TEAM_CONFIG, { modo: "empresa" })).toBeNull();
    expect(configDaJanela(empresaLigada, { modo: "empresa" })).toBe(empresaLigada);
    // Sem horário salvo no fluxo, o padrão é seguir a empresa.
    expect(configDaJanela(DEFAULT_TEAM_CONFIG)).toBeNull();
    expect(configDaJanela(empresaLigada)).toBe(empresaLigada);
  });

  it("'livre' nunca restringe, com a empresa ligada ou não", () => {
    expect(configDaJanela(DEFAULT_TEAM_CONFIG, { modo: "livre" })).toBeNull();
    expect(configDaJanela(empresaLigada, { modo: "livre" })).toBeNull();
  });

  it("'propria' usa os dias, horas e feriados do fluxo e o fuso da empresa, mesmo com a empresa desligada", () => {
    const c = configDaJanela({ ...DEFAULT_TEAM_CONFIG, timezone: "America/Cuiaba" }, propria)!;
    expect(c).toMatchObject({ respectBusinessHours: true, businessHourStart: "10:00", businessHourEnd: "12:00", businessDays: "mon,wed", respectHolidays: false, timezone: "America/Cuiaba" });
  });

  it("o próximo slot de um horário próprio: segunda 09:00 espera até 10:00; terça espera até quarta 10:00; 11:00 de segunda já pode", () => {
    const c = configDaJanela(DEFAULT_TEAM_CONFIG, propria)!;
    expect(proximoSlotDeEnvio(sp("2026-09-28T09:00:00"), c)).toEqual(sp("2026-09-28T10:00:00")); // segunda
    expect(proximoSlotDeEnvio(sp("2026-09-29T11:00:00"), c)).toEqual(sp("2026-09-30T10:00:00")); // terça → quarta
    const dentro = sp("2026-09-28T11:00:00");
    expect(proximoSlotDeEnvio(dentro, c)).toEqual(dentro);
    expect(proximoSlotDeEnvio(sp("2026-09-28T12:00:00"), c)).toEqual(sp("2026-09-30T10:00:00")); // depois de fechar
  });

  it("feriados: o horário próprio com feriados LIGADO pula o 20/11/2026 (sexta); desligado, não", () => {
    const sexta: JanelaEnvio = { modo: "propria", abertura: "08:00", fechamento: "18:00", dias: ["fri"], feriados: true };
    expect(proximoSlotDeEnvio(sp("2026-11-20T10:00:00"), configDaJanela(DEFAULT_TEAM_CONFIG, sexta)!)).toEqual(sp("2026-11-27T08:00:00"));
    const livreDeFeriado: JanelaEnvio = { ...sexta, feriados: false };
    const t = sp("2026-11-20T10:00:00");
    expect(proximoSlotDeEnvio(t, configDaJanela(DEFAULT_TEAM_CONFIG, livreDeFeriado)!)).toEqual(t);
  });

  it("adiamentoForaDaJanela com o horário do fluxo (empresa desligada, fluxo com horário próprio)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const segunda9h = sp("2026-09-28T09:00:00");
    vi.setSystemTime(segunda9h);
    // Empresa desligada (padrão) e fluxo sem horário: envia agora.
    expect(await runWithTeam(TEAM, () => adiamentoForaDaJanela(segunda9h), DONO)).toBeNull();
    // O mesmo instante, com o horário próprio do fluxo (abre às 10:00): espera 1 h + jitter.
    const d = await runWithTeam(TEAM, () => adiamentoForaDaJanela(segunda9h, propria), DONO);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThanOrEqual(3_600_000);
    expect(d!).toBeLessThanOrEqual(3_600_000 + JITTER_ABERTURA_MIN * 60_000);
    // "Qualquer hora" no fluxo: nunca espera.
    expect(await runWithTeam(TEAM, () => adiamentoForaDaJanela(sp("2026-09-26T02:00:00"), { modo: "livre" }), DONO)).toBeNull();
  });
});

describe("jitter de inscrição em lote", () => {
  it("lote sem jitter configurado: 0–30 min; unitário: 0; configurado: o do fluxo", () => {
    for (let i = 0; i < 20; i++) {
      const j = jitterDelayMs(null, true);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(JITTER_LOTE_PADRAO_MIN * 60_000);
    }
    expect(jitterDelayMs(null, false)).toBe(0);
    expect(jitterDelayMs({ jitterMin: 0, jitterMax: 0 }, true)).toBe(0); // o time escolheu "sem jitter"
  });
});
