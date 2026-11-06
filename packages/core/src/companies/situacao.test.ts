import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { conferirSituacaoDasEmpresas, situacaoEhAtiva } from "./situacao";

const TEAM = "00000000-0000-0000-0000-0000000005f3";
const adm = { userId: "ana", role: "admin" };

describe("situacaoEhAtiva", () => {
  it("só 'ativa' (qualquer caixa) é ativa; baixada, inapta, suspensa e nula não; vazio não se sabe", () => {
    expect(situacaoEhAtiva("ATIVA")).toBe(true);
    expect(situacaoEhAtiva(" Ativa ")).toBe(true);
    for (const t of ["BAIXADA", "INAPTA", "SUSPENSA", "NULA", "Inativa"]) expect(situacaoEhAtiva(t)).toBe(false);
    expect(situacaoEhAtiva("")).toBeNull();
    expect(situacaoEhAtiva(null)).toBeNull();
  });
});

describe("conferirSituacaoDasEmpresas", () => {
  let contatoId: string;
  beforeAll(async () => {
    await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Situacao (test)" } });
  });
  beforeEach(async () => {
    await basePrisma.contactCompany.deleteMany({ where: { teamId: TEAM } });
    await basePrisma.company.deleteMany({ where: { teamId: TEAM } });
    await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
    contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maria" } })).id;
  });
  const vincular = async (nome: string, cnpj: string | null, enrichment?: object) => {
    const co = await basePrisma.company.create({ data: { teamId: TEAM, nome, cnpj, ...(enrichment ? { enrichment } : {}) } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: contatoId, companyId: co.id } });
    return co.id;
  };
  const consulta = (porCnpj: Record<string, string | null | Error>) => async (cnpj: string) => {
    const v = porCnpj[cnpj];
    if (v instanceof Error) throw v;
    return { origem: "cache" as const, resultado: { situacao: v ?? null, consultadoEm: "2026-10-14T12:00:00.000Z" } };
  };

  it("grava ativa e inativa em cada empresa com CNPJ, sem apagar o resto do enrichment; a que não responde fica como estava", async () => {
    const a = await vincular("Ativa SA", "11111111000111", { campos: { email: { fonteRotulo: "x", consultadoEm: "y" } } });
    const b = await vincular("Baixada SA", "22222222000122");
    const c = await vincular("Sem resposta SA", "33333333000133");
    const d = await vincular("Sem CNPJ", null);
    const r = await runWithTeam(TEAM, () => conferirSituacaoDasEmpresas(contatoId, { consultarCnpj: consulta({ "11111111000111": "ATIVA", "22222222000122": "BAIXADA", "33333333000133": new Error("fora do ar") }) as never }), adm);
    expect(r).toEqual({ conferidas: 2, inativas: 1, semResposta: 1 });
    const ler = async (id: string) => (await basePrisma.company.findUniqueOrThrow({ where: { id } })).enrichment as Record<string, unknown> | null;
    expect(await ler(a)).toMatchObject({ campos: { email: { fonteRotulo: "x" } }, situacao: { ativa: true, descricao: "ATIVA", consultadoEm: "2026-10-14T12:00:00.000Z" } });
    expect(await ler(b)).toMatchObject({ situacao: { ativa: false, descricao: "BAIXADA" } });
    expect(await ler(c)).toBeNull();
    expect(await ler(d)).toBeNull();
  });

  it("só quem pode editar o contato confere; viewer é recusado", async () => {
    await vincular("X", "44444444000144");
    await expect(runWithTeam(TEAM, () => conferirSituacaoDasEmpresas(contatoId, { consultarCnpj: consulta({}) as never }), { userId: "v", role: "viewer" })).rejects.toThrow();
  });
});
