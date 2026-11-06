import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * Contas de canal: caminho manual sem WhatsApp e exclusão que apaga a instância
 * (auditoria do #53). A Evolution é MOCKADA — nada é criado, apagado ou
 * enviado de verdade — e qualquer `fetch` direto falha o teste (o caminho
 * manual não pode mais bater numa URL vinda do cliente).
 */
const evo = vi.hoisted(() => ({
  deleteEvolutionInstance: vi.fn(async (_i: { apiUrl: string; apiKey: string; instance: string }) => ({ ok: true as boolean, error: undefined as string | undefined })),
  verifyEvolutionInstance: vi.fn(async () => ({ ok: true, state: "open" })),
}));
vi.mock("@crmagro/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crmagro/channels")>()),
  ...evo,
}));
const fetchProibido = vi.fn(async (url: unknown) => {
  throw new Error(`fetch proibido no teste: ${String(url)}`);
});

const { criarContaDeCanal, excluirContaDeCanal, renomearContaDeCanal, WhatsAppSoPeloQr, InstanciaNaoRemovida } = await import("./contas");
const { ForbiddenError } = await import("../auth/authz");
const { OwnedNotFound } = await import("../tenancy/assert-owned");
const { env } = await import("@crmagro/config");

const TEAM_A = "00000000-0000-0000-0000-0000000001ad";
const TEAM_B = "00000000-0000-0000-0000-0000000001ae";
const ADMIN = { userId: "admin", role: "admin" };
const emA = <T>(fn: () => Promise<T>, id: { userId: string; role: string } = ADMIN) => runWithTeam(TEAM_A, fn, id);
const emB = <T>(fn: () => Promise<T>) => runWithTeam(TEAM_B, fn, ADMIN);

async function limpar() {
  await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
}
beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Time A (agente A — contas de canal)"],
    [TEAM_B, "Time B (agente A — contas de canal)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
  vi.stubGlobal("fetch", fetchProibido);
});
beforeEach(async () => {
  for (const f of Object.values(evo)) f.mockClear();
  fetchProibido.mockClear();
  evo.deleteEvolutionInstance.mockImplementation(async () => ({ ok: true, error: undefined }));
  await limpar();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await limpar();
});

async function contaEvolution(teamId: string, instance: string) {
  return basePrisma.channelAccount.create({
    data: { teamId, canal: "whatsapp", label: "WhatsApp", provider: "evolution", externalId: instance, credentials: { instance }, status: "connected" },
  });
}

describe("criarContaDeCanal (caminho manual)", () => {
  it("dois times: o A não reivindica a instância do B pelo nome — WhatsApp só pelo QR, sem nenhuma chamada de rede", async () => {
    // Instância real da plataforma: conta do B (e o caso "órfã": sem conta nenhuma).
    await contaEvolution(TEAM_B, "numero-do-b");
    for (const credentials of [
      { instance: "numero-do-b", apiUrl: "https://servidor-do-atacante.example" },
      { instance: "instancia-orfa", apiUrl: "http://169.254.169.254/latest" },
    ]) {
      await expect(
        emA(() => criarContaDeCanal({ canal: "whatsapp", label: "meu", provider: "evolution", credentials })),
      ).rejects.toBeInstanceOf(WhatsAppSoPeloQr);
    }
    // Nem com outro nome de provider, nem com outro canal apontando para a Evolution.
    await expect(emA(() => criarContaDeCanal({ canal: "whatsapp", label: "x", provider: "cloud", credentials: { instance: "numero-do-b" } }))).rejects.toBeInstanceOf(WhatsAppSoPeloQr);
    await expect(emA(() => criarContaDeCanal({ canal: "email", label: "x", provider: "evolution", credentials: { instance: "numero-do-b" } }))).rejects.toBeInstanceOf(WhatsAppSoPeloQr);

    expect(fetchProibido).not.toHaveBeenCalled();
    expect(evo.verifyEvolutionInstance).not.toHaveBeenCalled();
    expect(await basePrisma.channelAccount.count({ where: { teamId: TEAM_A } })).toBe(0);
    expect(await basePrisma.channelAccount.findMany({ where: { externalId: "numero-do-b" }, select: { teamId: true } })).toEqual([{ teamId: TEAM_B }]);
  });

  it("outros canais seguem pelo caminho manual (no time da sessão); só admin cria", async () => {
    const { id } = await emA(() => criarContaDeCanal({ canal: "instagram", label: "IG", provider: "instagram", credentials: { handle: "crmagro" } }));
    expect(await basePrisma.channelAccount.findUnique({ where: { id }, select: { teamId: true, canal: true } })).toEqual({ teamId: TEAM_A, canal: "instagram" });
    await expect(
      emA(() => criarContaDeCanal({ canal: "instagram", label: "IG", provider: "instagram", credentials: {} }), { userId: "v", role: "member" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("excluirContaDeCanal", () => {
  it("renomeia só o rótulo, exige admin e não permite conta de outro time", async () => {
    const c = await contaEvolution(TEAM_A, "renomear");
    await emA(() => renomearContaDeCanal(c.id, "  Meu WhatsApp  "));
    expect(await basePrisma.channelAccount.findUnique({ where: { id: c.id }, select: { label: true, externalId: true, status: true } }))
      .toEqual({ label: "Meu WhatsApp", externalId: "renomear", status: "connected" });
    await expect(emB(() => renomearContaDeCanal(c.id, "outro"))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(emA(() => renomearContaDeCanal(c.id, "x"), { userId: "member", role: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const nome of ["  ", "a".repeat(101)]) await expect(emA(() => renomearContaDeCanal(c.id, nome))).rejects.toThrow();
    expect(fetchProibido).not.toHaveBeenCalled();
  });
  it("conta Evolution: apaga a instância na Evolution do ENV e depois a conta", async () => {
    const conta = await contaEvolution(TEAM_A, "numero-do-a");
    await emA(() => excluirContaDeCanal(conta.id));
    expect(evo.deleteEvolutionInstance).toHaveBeenCalledTimes(1);
    expect(evo.deleteEvolutionInstance.mock.calls[0]![0]).toEqual({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance: "numero-do-a" });
    expect(await basePrisma.channelAccount.findUnique({ where: { id: conta.id } })).toBeNull();
  });

  it("Evolution falhou: a conta fica e o erro volta", async () => {
    const conta = await contaEvolution(TEAM_A, "numero-do-a2");
    evo.deleteEvolutionInstance.mockImplementation(async () => ({ ok: false, error: 'Evolution delete 500: {"stack":"segredo interno"}' }));
    const erro = await emA(() => excluirContaDeCanal(conta.id)).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(InstanciaNaoRemovida);
    // Mensagem fixa: o corpo cru da Evolution não vai para a tela.
    expect((erro as Error).message).toContain("a Evolution recusou (HTTP 500)");
    expect((erro as Error).message).not.toContain("segredo");
    evo.deleteEvolutionInstance.mockImplementation(async () => ({ ok: false, error: "fetch failed: ECONNREFUSED [alvo: http://evolution:8080]" }));
    const semResposta = await emA(() => excluirContaDeCanal(conta.id)).catch((e: unknown) => e);
    expect((semResposta as Error).message).toContain("a Evolution não respondeu");
    expect((semResposta as Error).message).not.toContain("evolution:8080");
    expect(await basePrisma.channelAccount.findUnique({ where: { id: conta.id } })).not.toBeNull();
  });

  it("dois times: o A não exclui a conta do B nem derruba a instância dele", async () => {
    const doB = await contaEvolution(TEAM_B, "numero-do-b2");
    await expect(emA(() => excluirContaDeCanal(doB.id))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(evo.deleteEvolutionInstance).not.toHaveBeenCalled();
    expect(await basePrisma.channelAccount.findUnique({ where: { id: doB.id } })).not.toBeNull();
    // O próprio B exclui.
    await emB(() => excluirContaDeCanal(doB.id));
    expect(evo.deleteEvolutionInstance).toHaveBeenCalledTimes(1);
  });

  it("conta que não é Evolution não chama a Evolution", async () => {
    const ig = await basePrisma.channelAccount.create({
      data: { teamId: TEAM_A, canal: "instagram", label: "IG", provider: "instagram", credentials: {}, status: "connected" },
    });
    await emA(() => excluirContaDeCanal(ig.id));
    expect(evo.deleteEvolutionInstance).not.toHaveBeenCalled();
    expect(await basePrisma.channelAccount.findUnique({ where: { id: ig.id } })).toBeNull();
  });
});
