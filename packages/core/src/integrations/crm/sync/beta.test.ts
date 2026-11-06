/** Gate do beta do Nectar: a lista de times vem do `.env` (CRM_BETA_TEAM_IDS). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithTeam } from "@crmagro/db";
import { aquecerBetaCrm, crmLiberadoParaOTime, exigirBetaCrm } from "./beta";
import { CrmForaDoBeta } from "../errors";

const TIME_LIGADO = "11111111-1111-4111-8111-111111111111";
const TIME_DESLIGADO = "22222222-2222-4222-8222-222222222222";
const comoTime = <T>(teamId: string, fn: () => Promise<T>) => runWithTeam(teamId, fn, { userId: "teste", role: "owner" });

let antes: string | undefined;
beforeEach(() => {
  antes = process.env.CRM_BETA_TEAM_IDS;
  delete process.env.CRM_BETA_TEAM_IDS;
});
afterEach(() => {
  if (antes === undefined) delete process.env.CRM_BETA_TEAM_IDS;
  else process.env.CRM_BETA_TEAM_IDS = antes;
});

describe("beta do Nectar", () => {
  it("sem lista, ninguém está liberado (fail-closed)", () => {
    expect(crmLiberadoParaOTime(TIME_LIGADO)).toBe(false);
    expect(crmLiberadoParaOTime(null)).toBe(false);
    expect(crmLiberadoParaOTime(undefined)).toBe(false);
  });

  it("libera só os ids da lista, sem diferenciar maiúscula", () => {
    process.env.CRM_BETA_TEAM_IDS = TIME_LIGADO.toUpperCase();
    expect(crmLiberadoParaOTime(TIME_LIGADO)).toBe(true);
    expect(crmLiberadoParaOTime(TIME_DESLIGADO)).toBe(false);
  });

  it("`todos` libera geral, mas continua sem liberar quem não tem time", () => {
    process.env.CRM_BETA_TEAM_IDS = "todos";
    expect(crmLiberadoParaOTime(TIME_DESLIGADO)).toBe(true);
    expect(crmLiberadoParaOTime(null)).toBe(false);
  });

  it("exigirBetaCrm deixa passar o time liberado e recusa o outro", async () => {
    process.env.CRM_BETA_TEAM_IDS = TIME_LIGADO;
    await aquecerBetaCrm(TIME_LIGADO);
    await expect(comoTime(TIME_LIGADO, () => exigirBetaCrm())).resolves.toBeUndefined();
    await expect(comoTime(TIME_DESLIGADO, () => exigirBetaCrm())).rejects.toBeInstanceOf(CrmForaDoBeta);
  });
});
