import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { cifrarCpf, hashDoCpf, preencherHashDoCpf } from "./cpf";
import { writeContact } from "./write";

/** Impressão do CPF (`cpfHash`): estável, por time, só para CPF de 11 dígitos, e preenchida para quem já tinha CPF. */
const TEAM = "00000000-0000-0000-0000-0000000000e1";
const OUTRO = "00000000-0000-0000-0000-0000000000e2";

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team cpf hash (${id.slice(-2)})` } });
});
afterAll(async () => {
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
});

describe("hashDoCpf", () => {
  it("é igual para o mesmo CPF (com ou sem pontuação), muda de um time para outro e ignora o que não é CPF", () => {
    expect(hashDoCpf(TEAM, "012.345.678-90")).toBe(hashDoCpf(TEAM, "01234567890"));
    expect(hashDoCpf(TEAM, "01234567890")).not.toBe(hashDoCpf(OUTRO, "01234567890"));
    expect(hashDoCpf(TEAM, "01234567890")).not.toContain("01234567890");
    expect(hashDoCpf(TEAM, "123")).toBeNull();
    expect(hashDoCpf(TEAM, null)).toBeNull();
    expect(hashDoCpf(null, "01234567890")).toBeNull();
  });
});

describe("gravação e preenchimento", () => {
  it("o cadastro novo já grava a impressão junto com o CPF cifrado", async () => {
    const r = await runWithTeam(TEAM, () => writeContact({ nome: "Com CPF", cpf: "01234567890", identifiers: { whatsapp: "+5565999991111" }, provenance: { source: "manual", actor: "human" } }, { mode: "create" }));
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: r.contactId } });
    expect(c.cpfHash).toBe(hashDoCpf(TEAM, "01234567890"));
  });

  it("preencherHashDoCpf completa quem tem CPF cifrado sem impressão e não refaz o que já tem", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Antigo", cpfCifrado: cifrarCpf("529.982.247-25") } });
    expect(await preencherHashDoCpf()).toBeGreaterThanOrEqual(1);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).cpfHash).toBe(hashDoCpf(OUTRO, "52998224725"));
    const de_novo = await basePrisma.contact.findMany({ where: { teamId: OUTRO, cpfHash: null, cpfCifrado: { not: null } } });
    expect(de_novo).toHaveLength(0);
  });
});
