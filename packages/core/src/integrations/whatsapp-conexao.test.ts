import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * WhatsApp desconectado visível e reconexão (item 1.6 — INT-04/INT-19). A
 * Evolution é MOCKADA: nada conecta, desconecta ou envia de verdade.
 */
const evo = vi.hoisted(() => ({
  getEvolutionQR: vi.fn(async () => ({ ok: true, state: "connecting", qrBase64: "data:image/png;base64,QR" })),
  verifyEvolutionInstance: vi.fn(async () => ({ ok: true, state: "open", number: null })),
}));
vi.mock("@crmagro/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crmagro/channels")>()),
  ...evo,
}));
const eventos = vi.hoisted(() => ({ publicados: [] as Array<{ type: string }> }));
vi.mock("../events/redis-bus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events/redis-bus")>()),
  publishRealtime: (e: { type: string }) => void eventos.publicados.push(e),
}));

const { aplicarEstadoDaConexao, verificarConexoesWhatsApp, reconectarContaWhatsApp, conferirReconexao } = await import(
  "./whatsapp-conexao"
);
const { acceptWhatsAppWebhook } = await import("../conversations/inbound-queue");
const { consumeSendQuota, adiamentoPorQueda } = await import("../channels-limit/service");
const { redisEstado } = await import("../shared/redis-cache");
const { parseEvolutionConnectionEvent } = await import("@crmagro/channels");

const TEAM = "00000000-0000-0000-0000-0000000000c8";
const ADMIN = { userId: "admin", role: "admin" };
const sufixo = Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Conexão (test)" } });
});

beforeEach(async () => {
  eventos.publicados.length = 0;
  evo.getEvolutionQR.mockClear();
  evo.verifyEvolutionInstance.mockClear();
  await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM } });
});

async function conta(extra: { status?: "connected" | "disconnected"; paused?: boolean } = {}) {
  return basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "whatsapp",
      label: "Comercial",
      provider: "evolution",
      externalId: `cx-${sufixo}-${Math.random().toString(36).slice(2, 6)}`,
      status: extra.status ?? "connected",
      paused: extra.paused ?? false,
    },
  });
}

describe("estado da conexão", () => {
  it("caiu → desconectada + PAUSADA (fluxos adiam) + evento para o banner; voltou → conectada e despausada", async () => {
    const c = await conta();
    expect(await aplicarEstadoDaConexao({ instance: c.externalId!, state: "close" })).toBe("desconectou");
    expect(await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: "disconnected",
      paused: true,
    });
    expect(eventos.publicados.map((e) => e.type)).toContain("channel:disconnected");

    expect(await aplicarEstadoDaConexao({ instance: c.externalId!, state: "open" })).toBe("reconectou");
    expect(await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: "connected",
      paused: false,
    });
  });

  it("pausa MANUAL numa conta conectada não é desfeita por um 'open'", async () => {
    const c = await conta({ paused: true });
    expect(await aplicarEstadoDaConexao({ instance: c.externalId!, state: "open" })).toBe("sem_mudanca");
    expect((await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } })).paused).toBe(true);
  });

  it("'connecting' (transitório) não muda nada; instância desconhecida é ignorada", async () => {
    const c = await conta();
    expect(await aplicarEstadoDaConexao({ instance: c.externalId!, state: "connecting" })).toBe("sem_mudanca");
    expect(await aplicarEstadoDaConexao({ instance: "nao-existe", state: "close" })).toBe("desconhecida");
  });

  it("verificação periódica aplica o estado real; Evolution fora (estado nulo) não mexe", async () => {
    const a = await conta();
    const b = await conta();
    const r = await verificarConexoesWhatsApp(async (instance) =>
      instance === a.externalId
        ? { ok: false, state: "close", number: null }
        : { ok: false, state: null, number: null, error: "timeout" },
    );
    expect(r.mudancas).toBeGreaterThanOrEqual(1);
    expect((await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("disconnected");
    expect((await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("connected");
  });
});

describe("auditoria do #66 — queda passageira e verificação", () => {
  it("adiamento por queda escalona: ~10 min logo depois, ~45 min até 3 h, depois próximo dia", () => {
    const agora = new Date();
    const ha = (ms: number) => new Date(agora.getTime() - ms);
    const curto = adiamentoPorQueda(ha(60_000), agora)!;
    expect(curto).toBeGreaterThanOrEqual(10 * 60_000);
    expect(curto).toBeLessThanOrEqual(15 * 60_000);
    const medio = adiamentoPorQueda(ha(60 * 60_000), agora)!;
    expect(medio).toBeGreaterThanOrEqual(45 * 60_000);
    expect(medio).toBeLessThanOrEqual(50 * 60_000);
    expect(adiamentoPorQueda(ha(5 * 3_600_000), agora)).toBeNull();
  });

  it("conta que ACABOU de cair adia o envio ~10 min (antes: próximo dia útil)", async () => {
    const c = await conta();
    await aplicarEstadoDaConexao({ instance: c.externalId!, state: "close" });
    const r = await runWithTeam(TEAM, () => consumeSendQuota(c.id), ADMIN);
    expect(r).toMatchObject({ allowed: false, reason: "paused" });
    if (!r.allowed) expect(r.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("verificação periódica não roda duas rodadas ao mesmo tempo", async () => {
    await conta();
    await redisEstado().del("wa:verificacao:rodada");
    let liberar!: () => void;
    const lenta = new Promise<void>((ok) => (liberar = ok));
    const primeira = verificarConexoesWhatsApp(async () => {
      await lenta;
      return { ok: true, state: "open", number: null };
    });
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await verificarConexoesWhatsApp(async () => ({ ok: true, state: "open", number: null }))).toEqual({ verificadas: 0, mudancas: 0 });
    liberar();
    expect((await primeira).verificadas).toBeGreaterThanOrEqual(1);
  });

  it("auditoria do #98: rodada que passou do prazo NÃO apaga a trava da rodada seguinte", async () => {
    await conta();
    await redisEstado().del("wa:verificacao:rodada");
    let liberar!: () => void;
    const lenta = new Promise<void>((ok) => (liberar = ok));
    const atrasada = verificarConexoesWhatsApp(async () => {
      await lenta;
      return { ok: true, state: "open", number: null };
    });
    await new Promise((ok) => setTimeout(ok, 50));
    // A trava da atrasada "expirou" e a rodada seguinte pegou a sua.
    await redisEstado().set("wa:verificacao:rodada", "token-da-seguinte", "EX", 280);
    liberar();
    await atrasada;
    expect(await redisEstado().get("wa:verificacao:rodada")).toBe("token-da-seguinte");
    await redisEstado().del("wa:verificacao:rodada");
  });
});

describe("webhook de conexão", () => {
  it("connection.update e qrcode.updated são reconhecidos e vão para a fila", async () => {
    const jobs: Array<{ kind: string }> = [];
    const enq = async (j: { kind: string }) => void jobs.push(j);
    const cx = { event: "connection.update", instance: "inst-1", data: { instance: "inst-1", state: "close", statusReason: 401 } };
    const qr = { event: "qrcode.updated", instance: "inst-1", data: { qrcode: { base64: "AAA" } } };
    expect((await acceptWhatsAppWebhook(cx, enq as never)).status).toBe(200);
    expect((await acceptWhatsAppWebhook(qr, enq as never)).status).toBe(200);
    expect(jobs.map((j) => j.kind)).toEqual(["conexao", "qr"]);
    expect(parseEvolutionConnectionEvent(qr)).toMatchObject({ tipo: "qr", qrBase64: "data:image/png;base64,AAA" });
    expect(parseEvolutionConnectionEvent({ event: "CONNECTION_UPDATE", instance: "x", data: { state: "open" } })).toMatchObject({ tipo: "conexao", state: "open" });
  });
});

describe("reconectar na MESMA conta", () => {
  it("devolve o QR; quando o QR é lido, a conta volta a conectada e despausada", async () => {
    const c = await conta({ status: "disconnected", paused: true });
    const r = await runWithTeam(TEAM, () => reconectarContaWhatsApp(c.id), ADMIN);
    expect(r).toEqual({ conectado: false, qrBase64: "data:image/png;base64,QR" });
    expect(evo.getEvolutionQR).toHaveBeenCalledWith(expect.objectContaining({ instance: c.externalId }));

    const ok = await runWithTeam(TEAM, () => conferirReconexao(c.id), ADMIN);
    expect(ok.conectado).toBe(true);
    expect(await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: "connected",
      paused: false,
    });
  });

  it("só admin, e só conta do próprio time", async () => {
    const c = await conta();
    await expect(runWithTeam(TEAM, () => reconectarContaWhatsApp(c.id), { userId: "m", role: "member" })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    await expect(
      runWithTeam("00000000-0000-0000-0000-0000000000c9", () => reconectarContaWhatsApp(c.id), ADMIN),
    ).rejects.toMatchObject({ name: "OwnedNotFound" });
  });
});
