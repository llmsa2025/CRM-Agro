import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * Onboarding de WhatsApp amarrado ao time (auditoria S4/INT-18, DP-04 — item 0.5).
 *
 * A Evolution é MOCKADA: nenhum teste cria, conecta ou apaga instância de
 * verdade (e nada é enviado a contato real). O Redis é o de teste.
 */
const evo = vi.hoisted(() => ({
  createEvolutionInstance: vi.fn(async () => ({ ok: true })),
  setEvolutionWebhook: vi.fn(async () => ({ ok: true })),
  getEvolutionQR: vi.fn(async () => ({ ok: true, state: "connecting", qrBase64: "QR" })),
  verifyEvolutionInstance: vi.fn(async () => ({ ok: true, state: "open", number: null })),
  deleteEvolutionInstance: vi.fn(async () => ({ ok: true })),
}));
const agendarHistorico = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./whatsapp-historico", () => ({ agendarHistoricoWhatsApp: agendarHistorico }));
vi.mock("@crmagro/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crmagro/channels")>()),
  ...evo,
}));

const {
  startWhatsAppOnboarding,
  checkWhatsAppOnboarding,
  cancelWhatsAppOnboarding,
  confirmWhatsAppOnboarding,
  gcPendingWhatsAppOnboardings,
  WA_MAX_PENDENTES_POR_TIME,
  WA_MAX_CONECTADAS_POR_TIME,
  WA_ONBOARD_TTL_MS,
} = await import("./whatsapp-onboarding");
const { resolveInboundAccount } = await import("../conversations/service");
const { ForbiddenError } = await import("../auth/authz");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM_A = "00000000-0000-0000-0000-0000000000e9";
const TEAM_B = "00000000-0000-0000-0000-0000000000ea";
const ADMIN = { userId: "admin", role: "admin" };
const emA = <T>(fn: () => Promise<T>, id = ADMIN) => runWithTeam(TEAM_A, fn, id);
const emB = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_B, fn, ADMIN);

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (wa)"],
    [TEAM_B, "Team B (wa)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  agendarHistorico.mockReset().mockResolvedValue(undefined);
  for (const f of Object.values(evo)) f.mockClear();
  await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
  const r = redisEstado();
  for (const t of [TEAM_A, TEAM_B]) {
    for (const inst of await r.zrange(`wa:onboard:time:${t}`, 0, -1)) {
      await r.del(`wa:onboard:${inst}`);
      await r.zrem("wa:onboard:pendentes", `${t}|${inst}`);
    }
    await r.del(`wa:onboard:time:${t}`);
  }
});

async function iniciarEmA(label = "Comercial") {
  const r = await emA(() => startWhatsAppOnboarding({ label }));
  if (!r.ok) throw new Error(r.error);
  return r.instance;
}

describe("instância amarrada ao time", () => {
  it("outro time não consulta, não cancela e não confirma a instância (Forbidden)", async () => {
    const instance = await iniciarEmA();
    await emB(async () => {
      await expect(checkWhatsAppOnboarding(instance)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(cancelWhatsAppOnboarding(instance)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(confirmWhatsAppOnboarding({ label: "roubo", instance })).rejects.toBeInstanceOf(ForbiddenError);
    });
    // Nada foi apagado na Evolution e nenhuma conta nasceu em B.
    expect(evo.deleteEvolutionInstance).not.toHaveBeenCalled();
    expect(await basePrisma.channelAccount.count({ where: { teamId: TEAM_B } })).toBe(0);
  });

  it("instância inventada (nunca iniciada) também é recusada", async () => {
    await emA(async () => {
      await expect(cancelWhatsAppOnboarding("instancia-do-env")).rejects.toBeInstanceOf(ForbiddenError);
    });
    expect(evo.deleteEvolutionInstance).not.toHaveBeenCalled();
  });

  it("o próprio time confirma: conta nasce com externalId e o inbound a acha pelo índice", async () => {
    const instance = await iniciarEmA();
    const r = await emA(() => confirmWhatsAppOnboarding({ label: "Comercial", instance }));
    expect(r.ok).toBe(true);
    const conta = await basePrisma.channelAccount.findFirstOrThrow({ where: { teamId: TEAM_A } });
    expect(conta.externalId).toBe(instance);
    expect(agendarHistorico).toHaveBeenCalledWith({ accountId: conta.id, teamId: TEAM_A, instance });
    expect(await resolveInboundAccount(instance)).toEqual({ id: conta.id, teamId: TEAM_A });
    // Pendência consumida: confirmar de novo é recusado.
    await expect(emA(() => confirmWhatsAppOnboarding({ label: "x", instance }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("falha ao agendar histórico não desfaz a conta confirmada; a varredura poderá retomá-la", async () => {
    const instance = await iniciarEmA();
    agendarHistorico.mockRejectedValueOnce(new Error("Redis temporariamente indisponível"));
    const r = await emA(() => confirmWhatsAppOnboarding({ label: "WA", instance }));
    expect(r.ok).toBe(true);
    expect(await basePrisma.channelAccount.count({ where: { teamId: TEAM_A, externalId: instance } })).toBe(1);
    await expect(emA(() => cancelWhatsAppOnboarding(instance))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a mesma instância não vira conta em dois times (unique provider+externalId)", async () => {
    const instance = await iniciarEmA();
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM_B, canal: "whatsapp", label: "B", provider: "evolution", externalId: instance, status: "connected" },
    });
    const r = await emA(() => confirmWhatsAppOnboarding({ label: "A", instance }));
    expect(r).toEqual({ ok: false, error: "esta instância já está ligada a uma conta" });
  });

  it("só admin inicia onboarding", async () => {
    await expect(
      emA(() => startWhatsAppOnboarding({ label: "x" }), { userId: "m", role: "member" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(evo.createEvolutionInstance).not.toHaveBeenCalled();
  });
});

describe("limites por time", () => {
  it(`no máximo ${WA_MAX_PENDENTES_POR_TIME} pendentes`, async () => {
    for (let i = 0; i < WA_MAX_PENDENTES_POR_TIME; i++) await iniciarEmA(`p${i}`);
    const r = await emA(() => startWhatsAppOnboarding({ label: "mais uma" }));
    expect(r.ok).toBe(false);
    expect(evo.createEvolutionInstance).toHaveBeenCalledTimes(WA_MAX_PENDENTES_POR_TIME);
  });

  it(`no máximo ${WA_MAX_CONECTADAS_POR_TIME} conectadas`, async () => {
    for (let i = 0; i < WA_MAX_CONECTADAS_POR_TIME; i++) {
      await basePrisma.channelAccount.create({
        data: { teamId: TEAM_A, canal: "whatsapp", label: `n${i}`, provider: "evolution", externalId: `ext-a-${i}-${Math.random().toString(36).slice(2, 8)}`, status: "connected" },
      });
    }
    const r = await emA(() => startWhatsAppOnboarding({ label: "sexta" }));
    expect(r.ok).toBe(false);
    expect(evo.createEvolutionInstance).not.toHaveBeenCalled();
  });
});

describe("GC de pendentes", () => {
  it("pendente vencida é apagada na Evolution; a que virou conta, não", async () => {
    const abandonada = await iniciarEmA("abandonada");
    const confirmada = await iniciarEmA("confirmada");
    // Confirm concorrente: a conta existe, mas a pendência ainda está no índice.
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM_A, canal: "whatsapp", label: "ok", provider: "evolution", externalId: confirmada, status: "connected" },
    });

    await gcPendingWhatsAppOnboardings(Date.now() + WA_ONBOARD_TTL_MS + 60_000);

    const apagadas = evo.deleteEvolutionInstance.mock.calls.map((c) => (c as unknown as [{ instance: string }])[0].instance);
    expect(apagadas).toContain(abandonada);
    expect(apagadas).not.toContain(confirmada);
    expect(await redisEstado().get(`wa:onboard:${abandonada}`)).toBeNull();
  });
});

describe("inbound", () => {
  it("instância desconhecida com várias contas no sistema → descarta (null)", async () => {
    const sufixo = Math.random().toString(36).slice(2, 8);
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM_A, canal: "whatsapp", label: "a", provider: "evolution", externalId: `wa-a-${sufixo}`, status: "connected" },
    });
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM_B, canal: "whatsapp", label: "b", provider: "evolution", externalId: `wa-b-${sufixo}`, status: "connected" },
    });
    expect(await resolveInboundAccount(`nao-existe-${sufixo}`)).toBeNull();
    expect((await resolveInboundAccount(`wa-b-${sufixo}`))?.teamId).toBe(TEAM_B);
  });
});
