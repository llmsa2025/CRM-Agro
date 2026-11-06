import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { env, envSchema, modoHistoricoWhatsApp } from "@crmagro/config";

/**
 * Chave WA_HISTORICO_MODO: a importação automática do histórico do WhatsApp só
 * roda no modo "completo"; sem a variável, NADA é agendado nem importado.
 * Sem banco, sem Redis, sem rede: fila (bullmq), Prisma e nomes são falsos.
 */
const fila = vi.hoisted(() => ({ add: vi.fn(async (..._args: unknown[]) => ({})) }));
const prisma = vi.hoisted(() => ({
  findMany: vi.fn(async () => [] as unknown[]),
  findFirst: vi.fn(async () => null),
}));
const nomes = vi.hoisted(() => ({ sincronizarNomesWhatsApp: vi.fn(async () => {}) }));
vi.mock("bullmq", () => ({ Queue: vi.fn(() => fila) }));
vi.mock("@crmagro/db", () => ({
  basePrisma: { channelAccount: { findMany: prisma.findMany, findFirst: prisma.findFirst } },
}));
vi.mock("../shared/redis-cache", () => ({ redisEstado: () => ({}) }));
vi.mock("./whatsapp-nomes", () => nomes);

const { agendarHistoricoWhatsApp, agendarHistoricosWhatsApp, processarHistoricoWhatsApp, importacaoHistoricoLigada } =
  await import("./whatsapp-historico");

const job = { accountId: "conta-1", teamId: "time-1", instance: "instancia-1" };
const original = env.WA_HISTORICO_MODO;

beforeEach(() => {
  fila.add.mockClear();
  prisma.findMany.mockReset().mockResolvedValue([]);
  prisma.findFirst.mockReset().mockResolvedValue(null);
  nomes.sincronizarNomesWhatsApp.mockClear();
});
afterEach(() => {
  env.WA_HISTORICO_MODO = original;
});

describe("modoHistoricoWhatsApp (puro)", () => {
  it("ausente, vazio, off e desligado = desligado", () => {
    for (const v of [undefined, null, "", "   ", "off", "OFF", "desligado"]) {
      expect(modoHistoricoWhatsApp(v)).toBe("desligado");
    }
  });
  it("completo (e o alias tudo) = completo, sem diferenciar caixa nem espaços", () => {
    for (const v of ["completo", " Completo ", "tudo", "TUDO"]) {
      expect(modoHistoricoWhatsApp(v)).toBe("completo");
    }
  });
  it("valor desconhecido ou modo ainda não implementado cai em desligado (fail-safe)", () => {
    for (const v of ["janela", "sob_demanda", "ligado", "true", "1", "completoo"]) {
      expect(modoHistoricoWhatsApp(v)).toBe("desligado");
    }
  });
});

describe("env — WA_HISTORICO_MODO", () => {
  const campo = envSchema.shape.WA_HISTORICO_MODO;
  it("vazio ou ausente não derruba o boot", () => {
    expect(campo.safeParse("")).toEqual({ success: true, data: undefined });
    expect(campo.safeParse(undefined)).toEqual({ success: true, data: undefined });
  });
  it("qualquer texto passa pelo schema (a decisão fail-safe é da função pura)", () => {
    expect(campo.safeParse("completo")).toEqual({ success: true, data: "completo" });
    expect(campo.safeParse("sob_demanda")).toEqual({ success: true, data: "sob_demanda" });
  });
});

describe("importação desligada (variável ausente)", () => {
  beforeEach(() => {
    env.WA_HISTORICO_MODO = undefined;
  });
  it("a chave está desligada", () => {
    expect(importacaoHistoricoLigada()).toBe(false);
  });
  it("confirmar o QR (agendarHistoricoWhatsApp) não põe nada na fila", async () => {
    await agendarHistoricoWhatsApp(job);
    expect(fila.add).not.toHaveBeenCalled();
  });
  it("a varredura do worker não consulta contas nem agenda", async () => {
    await agendarHistoricosWhatsApp();
    expect(prisma.findMany).not.toHaveBeenCalled();
    expect(fila.add).not.toHaveBeenCalled();
  });
  it("job que já estava na fila não importa nada nem sincroniza nomes", async () => {
    await processarHistoricoWhatsApp(job);
    expect(prisma.findFirst).not.toHaveBeenCalled();
    expect(nomes.sincronizarNomesWhatsApp).not.toHaveBeenCalled();
  });
  it("valor inválido também fica desligado", async () => {
    env.WA_HISTORICO_MODO = "sob_demanda";
    await agendarHistoricoWhatsApp(job);
    await agendarHistoricosWhatsApp();
    expect(fila.add).not.toHaveBeenCalled();
    expect(prisma.findMany).not.toHaveBeenCalled();
  });
});

describe("importação ligada (WA_HISTORICO_MODO=completo)", () => {
  beforeEach(() => {
    env.WA_HISTORICO_MODO = "completo";
  });
  it("a chave está ligada", () => {
    expect(importacaoHistoricoLigada()).toBe(true);
  });
  it("confirmar o QR agenda o job da conta", async () => {
    await agendarHistoricoWhatsApp(job);
    expect(fila.add).toHaveBeenCalledTimes(1);
    expect(fila.add).toHaveBeenCalledWith("sincronizar", job, expect.objectContaining({ jobId: "wa-history-conta-1" }));
  });
  it("a varredura agenda uma vez cada conta conectada", async () => {
    prisma.findMany.mockResolvedValue([
      { id: "a", teamId: "t1", externalId: "ia" },
      { id: "b", teamId: "t2", externalId: "ib" },
    ]);
    await agendarHistoricosWhatsApp();
    expect(fila.add).toHaveBeenCalledTimes(2);
    expect(fila.add).toHaveBeenCalledWith("sincronizar", { accountId: "b", teamId: "t2", instance: "ib" }, expect.anything());
  });
  it("o job entra no processamento: consulta a conta e roda a rodada de nomes", async () => {
    await processarHistoricoWhatsApp(job);
    expect(prisma.findFirst).toHaveBeenCalledTimes(1); // conta não achada: encerra sem importar
    expect(nomes.sincronizarNomesWhatsApp).toHaveBeenCalledTimes(1);
  });
});
