import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisCache } from "../shared/redis-cache";
import { aplicarEstadoDaConexao } from "../integrations/whatsapp-conexao";
import {
  consumeSendQuota,
  devolverCotaDeEnvio,
  getPrimaryWhatsAppStatus,
  invalidarStatusWhatsApp,
  setAccountPaused,
} from "./index";

/**
 * Bloco do WhatsApp no menu (item 2.9, N11): 1 consulta, cache Redis de 60 s
 * por time, invalidado quando os envios do dia, a pausa ou a conexão mudam.
 * Nada é enviado: só o contador de cota é exercitado.
 */
const TEAM = "00000000-0000-0000-0000-0000000002a3";
const OUTRO = "00000000-0000-0000-0000-0000000002a4";
const sufixo = Math.random().toString(36).slice(2, 8);

async function limpar(teamId: string) {
  await basePrisma.channelAccountUsage.deleteMany({ where: { teamId } });
  await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  await invalidarStatusWhatsApp(teamId); // a limpeza é por fora do serviço
}

function conta(teamId: string, extra: Record<string, unknown> = {}) {
  return basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: "WA", provider: "evolution", status: "connected", ...extra },
  });
}

/** Escrita por FORA do serviço (não invalida): prova que o valor vem do cache. */
async function somarUsoPorFora(channelAccountId: string, n: number) {
  await basePrisma.channelAccountUsage.updateMany({ where: { channelAccountId }, data: { sent: { increment: n } } });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Menu WA (test)"], [OUTRO, "Team Menu WA B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisCache();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});

beforeEach(async () => {
  await limpar(TEAM);
  await limpar(OUTRO);
});

describe("getPrimaryWhatsAppStatus — valor", () => {
  it("envios de hoje, teto, restante, aquecimento e estado da conta", async () => {
    const c = await conta(TEAM, { label: "Comercial", dailyLimit: 10 });
    await runWithTeam(TEAM, async () => {
      for (let i = 0; i < 3; i++) await consumeSendQuota(c.id);
      expect(await getPrimaryWhatsAppStatus()).toEqual({
        channelAccountId: c.id,
        label: "Comercial",
        status: "connected",
        paused: false,
        sent: 3,
        limit: 10,
        remaining: 7,
        warmupDay: 0,
        desconectadaEm: null,
      });
    });
  });

  it("principal = a conectada mais antiga; sem conectada, mostra a desconectada; sem conta → null", async () => {
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus())).toBeNull();
    const caida = await conta(TEAM, { label: "Antiga", status: "disconnected", createdAt: new Date("2026-01-01T00:00:00Z") });
    await invalidarStatusWhatsApp(TEAM);
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus())).toMatchObject({
      channelAccountId: caida.id,
      status: "disconnected",
    });
    const ativa = await conta(TEAM, { label: "Nova", createdAt: new Date("2026-06-01T00:00:00Z") });
    await invalidarStatusWhatsApp(TEAM);
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus())).toMatchObject({
      channelAccountId: ativa.id,
      status: "connected",
    });
  });
});

describe("getPrimaryWhatsAppStatus — cache invalidado", () => {
  it("consumir a cota invalida; devolver a cota invalida", async () => {
    const c = await conta(TEAM, { dailyLimit: 10 });
    await runWithTeam(TEAM, async () => {
      await consumeSendQuota(c.id);
      expect((await getPrimaryWhatsAppStatus())?.sent).toBe(1);
      await somarUsoPorFora(c.id, 2);
      expect((await getPrimaryWhatsAppStatus())?.sent).toBe(1); // do cache
      await consumeSendQuota(c.id);
      expect((await getPrimaryWhatsAppStatus())?.sent).toBe(4); // 1 + 2 por fora + 1
      await devolverCotaDeEnvio(c.id);
      expect((await getPrimaryWhatsAppStatus())?.sent).toBe(3);
    });
  });

  it("pausar/despausar e a queda da conexão aparecem na hora", async () => {
    const instancia = `menu-wa-${sufixo}`;
    const c = await conta(TEAM, { externalId: instancia });
    await runWithTeam(TEAM, async () => {
      expect((await getPrimaryWhatsAppStatus())?.paused).toBe(false);
      await setAccountPaused(c.id, true);
      expect((await getPrimaryWhatsAppStatus())?.paused).toBe(true);
      await setAccountPaused(c.id, false);
      expect((await getPrimaryWhatsAppStatus())?.paused).toBe(false);
    });
    // Evento `connection.update` (webhook/worker, sem sessão).
    await aplicarEstadoDaConexao({ instance: instancia, state: "close" });
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus())).toMatchObject({
      status: "disconnected",
      paused: true,
    });
    await aplicarEstadoDaConexao({ instance: instancia, state: "open" });
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus())).toMatchObject({
      status: "connected",
      paused: false,
    });
  });
});

describe("dois times", () => {
  it("cada time vê a própria conta; consumir no B não mexe no cache do A", async () => {
    const a = await conta(TEAM, { label: "A", dailyLimit: 10 });
    const b = await conta(OUTRO, { label: "B", dailyLimit: 20 });
    const doA = await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus());
    const doB = await runWithTeam(OUTRO, () => getPrimaryWhatsAppStatus());
    expect(doA).toMatchObject({ channelAccountId: a.id, label: "A", limit: 10, sent: 0 });
    expect(doB).toMatchObject({ channelAccountId: b.id, label: "B", limit: 20, sent: 0 });

    await runWithTeam(OUTRO, () => consumeSendQuota(b.id));
    expect(await runWithTeam(OUTRO, () => getPrimaryWhatsAppStatus())).toMatchObject({ sent: 1 });
    expect(await runWithTeam(TEAM, () => getPrimaryWhatsAppStatus())).toMatchObject({ channelAccountId: a.id, sent: 0 });
  });
});
