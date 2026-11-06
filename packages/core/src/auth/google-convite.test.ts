import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { provisionUserFromGoogle, googleSignInPermitido, SemConvite } from "./provisioning";

/**
 * Acesso pelo Google: conta existente, convite pendente, cadastro fechado
 * (produto, item G). Antes, e-mail desconhecido SEMPRE criava um time novo —
 * inclusive o de quem tinha convite para um time existente.
 */

const TEAM = "00000000-0000-0000-0000-0000000000c1";
const sufixo = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Time que convida (test)" } });
});

beforeEach(async () => {
  await basePrisma.invite.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
});

async function convidar(email: string, extra: { role?: string; expiresAt?: Date; revokedAt?: Date } = {}) {
  return basePrisma.invite.create({
    data: {
      teamId: TEAM,
      email,
      role: extra.role ?? "member",
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      tokenPrefix: "inv_test",
      expiresAt: extra.expiresAt ?? new Date(Date.now() + 86_400_000),
      ...(extra.revokedAt ? { revokedAt: extra.revokedAt } : {}),
    },
  });
}

describe("login Google com convite", () => {
  it("convite pendente → entra NO TIME DO CONVITE com o papel do convite; convite aceito", async () => {
    const email = `convidado.${sufixo()}@exemplo.com.br`;
    const inv = await convidar(email, { role: "admin" });
    expect(await googleSignInPermitido(email, { cadastroAberto: false })).toBe(true);

    const r = await provisionUserFromGoogle({ email, name: "Convidado" }, { cadastroAberto: false });
    expect(r.teamId).toBe(TEAM);
    expect(r.role).toBe("admin");
    expect((await basePrisma.invite.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).not.toBeNull();
    // Nenhum time novo foi criado para ele.
    expect(await basePrisma.team.count({ where: { name: "Time de Convidado" } })).toBe(0);
  });

  it("convite com papel owner nunca vira owner (cai para member)", async () => {
    const email = `dono.falso.${sufixo()}@exemplo.com.br`;
    await convidar(email, { role: "owner" });
    const r = await provisionUserFromGoogle({ email }, { cadastroAberto: false });
    expect(r.role).toBe("member");
  });

  it("dois logins simultâneos com o mesmo convite → um usuário só", async () => {
    const email = `corrida.${sufixo()}@exemplo.com.br`;
    await convidar(email);
    const [a, b] = await Promise.all([
      provisionUserFromGoogle({ email }, { cadastroAberto: false }),
      provisionUserFromGoogle({ email }, { cadastroAberto: false }),
    ]);
    expect(a.userId).toBe(b.userId);
    expect(await basePrisma.user.count({ where: { email } })).toBe(1);
  });
});

describe("cadastro fechado (padrão)", () => {
  it("sem conta e sem convite → SemConvite, e nenhum time é criado", async () => {
    const email = `estranho.${sufixo()}@exemplo.com.br`;
    const times = await basePrisma.team.count();
    expect(await googleSignInPermitido(email, { cadastroAberto: false })).toBe(false);
    await expect(provisionUserFromGoogle({ email }, { cadastroAberto: false })).rejects.toBeInstanceOf(SemConvite);
    expect(await basePrisma.team.count()).toBe(times);
  });

  it("convite vencido ou revogado não vale", async () => {
    const vencido = `vencido.${sufixo()}@exemplo.com.br`;
    const revogado = `revogado.${sufixo()}@exemplo.com.br`;
    await convidar(vencido, { expiresAt: new Date(Date.now() - 1000) });
    await convidar(revogado, { revokedAt: new Date() });
    expect(await googleSignInPermitido(vencido, { cadastroAberto: false })).toBe(false);
    expect(await googleSignInPermitido(revogado, { cadastroAberto: false })).toBe(false);
  });

  it("conta existente entra normalmente (mesmo com cadastro fechado)", async () => {
    const email = `existente.${sufixo()}@exemplo.com.br`;
    const u = await basePrisma.user.create({ data: { teamId: TEAM, name: "Já", email, role: "member" } });
    expect(await googleSignInPermitido(email, { cadastroAberto: false })).toBe(true);
    expect((await provisionUserFromGoogle({ email }, { cadastroAberto: false })).userId).toBe(u.id);
  });

  it("cadastro aberto → e-mail novo sem convite cria time próprio (comportamento antigo)", async () => {
    const email = `aberto.${sufixo()}@exemplo.com.br`;
    const r = await provisionUserFromGoogle({ email, name: "Aberto" }, { cadastroAberto: true });
    expect(r.role).toBe("owner");
    expect(r.teamId).not.toBe(TEAM);
    // limpeza do time criado
    await basePrisma.goal.deleteMany({ where: { teamId: r.teamId } });
    await basePrisma.stage.deleteMany({ where: { teamId: r.teamId } });
    await basePrisma.funnel.deleteMany({ where: { teamId: r.teamId } });
    await basePrisma.user.deleteMany({ where: { teamId: r.teamId } });
    await basePrisma.team.delete({ where: { id: r.teamId } });
  });
});
