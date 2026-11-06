import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ZodError } from "zod";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { create, update, getById } from "./service";
import { createContactWithCompany } from "../companies/service";
import { numeroBR, contactUpdateSchema } from "./schema";

/**
 * Área (ha) e faturamento anual (R$) no contato — opcionais, digitados em
 * pt-BR ("1.250" = mil duzentos e cinquenta), limpáveis na edição.
 */
const TEAM = "00000000-0000-0000-0000-00000000c4b1";

const limpar = () => basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team área/faturamento (test)" } });
});
beforeEach(limpar);
afterAll(limpar);

const emA = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn);

describe("numeroBR", () => {
  it("entende o número como a pessoa digita", () => {
    expect(numeroBR("1.250")).toBe(1250);
    expect(numeroBR("2,5")).toBe(2.5);
    expect(numeroBR("1.250,75")).toBe(1250.75);
    expect(numeroBR("R$ 2.400.000")).toBe(2_400_000);
    expect(numeroBR("12.5")).toBe(12.5);
    expect(numeroBR("")).toBeNull();
    expect(numeroBR(null)).toBeNull();
    expect(numeroBR(undefined)).toBeUndefined();
    expect(numeroBR(3)).toBe(3);
  });
});

describe("contato com área e faturamento", () => {
  it("create grava; update com null limpa; ausente não mexe", async () => {
    const c = await emA(() => create({ nome: "Fazenda", tags: [], areaHa: 1250, faturamentoAnual: 2_400_000 }));
    expect(c).toMatchObject({ areaHa: 1250, faturamentoAnual: 2_400_000 });

    await emA(() => update(c.id, contactUpdateSchema.parse({ nome: "Fazenda Boa" })));
    expect(await emA(() => getById(c.id))).toMatchObject({ nome: "Fazenda Boa", areaHa: 1250, faturamentoAnual: 2_400_000 });

    await emA(() => update(c.id, contactUpdateSchema.parse({ areaHa: "", faturamentoAnual: "3.000.000" })));
    expect(await emA(() => getById(c.id))).toMatchObject({ areaHa: null, faturamentoAnual: 3_000_000 });
  });

  it("formulário completo (createContactWithCompany) aceita o texto digitado", async () => {
    const { contactId } = await emA(() => createContactWithCompany({ person: { nome: "Produtor", areaHa: "5.000", faturamentoAnual: "" } }));
    expect(await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } })).toMatchObject({ areaHa: 5000, faturamentoAnual: null });
  });

  it("negativo, texto e acima do teto são recusados", () => {
    expect(() => contactUpdateSchema.parse({ areaHa: "-1" })).toThrow(ZodError);
    expect(() => contactUpdateSchema.parse({ areaHa: "muito" })).toThrow(ZodError);
    expect(() => contactUpdateSchema.parse({ faturamentoAnual: 2e12 })).toThrow(ZodError);
  });
});
