import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * `ChannelAccount.desconectadaEm` (ajuste do item 1.6): a hora da QUEDA fica
 * numa coluna própria. Antes o adiamento por queda contava do `updatedAt`, que
 * anda com qualquer mudança da conta — editar o rótulo de uma conta caída há 5 h
 * fazia o motor achar que ela "acabou de cair" e tentar de novo a cada 10 min.
 * A Evolution não é chamada; o barramento de tempo real é mockado.
 */
vi.mock("../events/redis-bus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events/redis-bus")>()),
  publishRealtime: () => undefined,
}));

const { aplicarEstadoDaConexao } = await import("./whatsapp-conexao");
const { consumeSendQuota, getAccountRateStatus, getPrimaryWhatsAppStatus, invalidarStatusWhatsApp, quandoCaiu } = await import(
  "../channels-limit/service"
);

const TEAM = "00000000-0000-0000-0000-0000000007a5";
const ADMIN = { userId: "admin", role: "admin" };
const H = 3_600_000;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Queda (test G)" } });
});
beforeEach(async () => {
  await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM } });
  await invalidarStatusWhatsApp(TEAM);
});

async function conta(dados: { status?: "connected" | "disconnected"; paused?: boolean; desconectadaEm?: Date | null } = {}) {
  return basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "whatsapp",
      label: "Comercial (test G)",
      provider: "evolution",
      externalId: `g-queda-${Math.random().toString(36).slice(2, 10)}`,
      status: dados.status ?? "connected",
      paused: dados.paused ?? false,
      desconectadaEm: dados.desconectadaEm ?? null,
    },
  });
}

describe("desconectadaEm — grava na queda, limpa na volta", () => {
  it("caiu → hora da queda gravada e exposta nos DTOs; voltou → null", async () => {
    const c = await conta();
    const antes = Date.now();
    await aplicarEstadoDaConexao({ instance: c.externalId!, state: "close" });
    const caida = await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } });
    expect(caida.status).toBe("disconnected");
    expect(caida.desconectadaEm!.getTime()).toBeGreaterThanOrEqual(antes - 1000);

    const menu = await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus(), ADMIN);
    expect(menu).toMatchObject({ channelAccountId: c.id, status: "disconnected", desconectadaEm: caida.desconectadaEm!.toISOString() });
    const cota = await runWithTeam(TEAM, () => getAccountRateStatus(c.id), ADMIN);
    expect(cota?.desconectadaEm).toBe(caida.desconectadaEm!.toISOString());

    // Nova queda informada de novo (webhook + verificação) não muda a hora da 1ª.
    await aplicarEstadoDaConexao({ instance: c.externalId!, state: "close" });
    expect((await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } })).desconectadaEm).toEqual(caida.desconectadaEm);

    await aplicarEstadoDaConexao({ instance: c.externalId!, state: "open" });
    const volta = await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } });
    expect(volta).toMatchObject({ status: "connected", paused: false, desconectadaEm: null });
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus(), ADMIN)).toMatchObject({ status: "connected", desconectadaEm: null });
  });

  it("o adiamento conta da QUEDA, não do updatedAt: conta caída há 5 h e editada agora não volta a tentar em 10 min", async () => {
    // Relógio do teste: quarta 10:00 em São Paulo (longe da virada do dia).
    const agora = new Date("2026-09-30T13:00:00.000Z");
    const caidaHa5h = await conta({ status: "disconnected", paused: true, desconectadaEm: new Date(agora.getTime() - 5 * H) });
    // Edição qualquer da conta: o `updatedAt` anda para "agora".
    await basePrisma.channelAccount.update({ where: { id: caidaHa5h.id }, data: { label: "Comercial renomeado", updatedAt: agora } });
    const longa = await runWithTeam(TEAM, () => consumeSendQuota(caidaHa5h.id, agora), ADMIN);
    expect(longa).toMatchObject({ allowed: false, reason: "paused" });
    if (!longa.allowed) expect(longa.retryAfterMs).toBeGreaterThan(3 * H); // próximo dia útil

    const caidaAgora = await conta({ status: "disconnected", paused: true, desconectadaEm: new Date(agora.getTime() - 60_000) });
    const curta = await runWithTeam(TEAM, () => consumeSendQuota(caidaAgora.id, agora), ADMIN);
    if (curta.allowed) throw new Error("conta caída não pode enviar");
    expect(curta.retryAfterMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(curta.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("conta que caiu antes da coluna existir (sem desconectadaEm) usa o updatedAt, como antes; conectada → null", () => {
    const u = new Date("2026-09-01T00:00:00.000Z");
    const d = new Date("2026-09-02T00:00:00.000Z");
    expect(quandoCaiu({ status: "disconnected", desconectadaEm: null, updatedAt: u })).toEqual(u);
    expect(quandoCaiu({ status: "disconnected", desconectadaEm: d, updatedAt: u })).toEqual(d);
    expect(quandoCaiu({ status: "connected", desconectadaEm: d, updatedAt: u })).toBeNull();
    expect(quandoCaiu({ status: "error", desconectadaEm: null, updatedAt: u })).toBeNull();
  });
});
