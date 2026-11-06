import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { createInvite, acceptInvite, aceitarConviteComSenha, EmailJaCadastrado } from "./invites";
import { consumePasswordReset, redefinirSenhaComToken } from "./password-reset";
import { getSessionState, sessionIsCurrent, revokeUserSessions } from "./session";
import { checkLoginRateLimit, registrarFalhaDeLogin, registrarSucessoDeLogin, LOGIN_LIMITES } from "./login-guard";
import { rateLimit, peekRateLimit } from "../rate-limit/service";

/**
 * Conta: convite, reset de senha, sessão e limite de login (auditoria S9, S8,
 * S12 — item 0.4). Os testes de limite usam Redis (REDIS_URL_TEST no VPS, o
 * service container no CI) com chaves únicas por execução.
 */

const TEAM_A = "00000000-0000-0000-0000-0000000000d9";
const TEAM_B = "00000000-0000-0000-0000-0000000000da";
// Master (owner): desde a F2a, administrador só convida com a permissão
// "convidar" liberada pelo master (coberta em auth/equipe.test.ts).
const ADMIN_A = { userId: "admin-a", role: "owner" };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const unico = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (conta)"],
    [TEAM_B, "Team B (conta)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  await basePrisma.invite.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
  await basePrisma.user.deleteMany({ where: { teamId: { in: [TEAM_A, TEAM_B] } } });
});

async function usuario(teamId: string, email: string, role = "owner") {
  return basePrisma.user.create({ data: { teamId, name: email, email, role, passwordHash: "hash-original" } });
}

/** Convite gravado direto (sem e-mail), com token conhecido. */
async function convite(teamId: string, email: string) {
  const token = `inv_${randomUUID()}`;
  await basePrisma.invite.create({
    data: {
      teamId,
      email,
      role: "member",
      tokenHash: sha(token),
      tokenPrefix: token.slice(0, 8),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return token;
}

describe("convite (S9)", () => {
  it("createInvite: quem já é do PRÓPRIO time é recusado; conta de OUTRO time não é revelada (e o aceite não a toca)", async () => {
    await usuario(TEAM_A, "dono.a@exemplo.com.br");
    const donoB = await usuario(TEAM_B, "dono.b@exemplo.com.br");
    const convites = await runWithTeam(
      TEAM_A,
      async () => {
        await expect(createInvite({ email: "dono.a@exemplo.com.br" })).rejects.toBeInstanceOf(EmailJaCadastrado);
        // Mesma resposta de um e-mail que ninguém usa: nada distingue o usuário do time B.
        const deOutroTime = await createInvite({ email: "DONO.B@exemplo.com.br" });
        const livre = await createInvite({ email: "livre@exemplo.com.br" });
        return { deOutroTime, livre };
      },
      ADMIN_A,
    );
    expect(Object.keys(convites.deOutroTime).sort()).toEqual(Object.keys(convites.livre).sort());
    expect(convites.deOutroTime.email).toBe("dono.b@exemplo.com.br");
    expect(await basePrisma.invite.count({ where: { teamId: TEAM_A } })).toBe(2);

    // O dono do B abre o link: não muda de time nem de senha.
    const res = await acceptInvite(convites.deOutroTime.token, { name: "x", passwordHash: "hash-do-admin-a" });
    expect(res).toEqual({ ok: false, reason: "email_in_other_team" });
    const depois = await basePrisma.user.findUniqueOrThrow({ where: { id: donoB.id } });
    expect([depois.teamId, depois.passwordHash]).toEqual([TEAM_B, "hash-original"]);
  });

  it("aceitarConviteComSenha: limite, senha curta, convite inválido e e-mail com conta barram ANTES do bcrypt", async () => {
    const hashSenha = vi.fn(async (s: string) => `hash(${s})`);
    const ip = `203.0.113.${unico()}`;
    expect(await aceitarConviteComSenha("inv_inexistente", { name: "x", senha: "senha-boa-123" }, { ip, hashSenha })).toEqual({ ok: false, reason: "invalid" });
    const token = await convite(TEAM_A, "curta@exemplo.com.br");
    expect(await aceitarConviteComSenha(token, { name: "x", senha: "1234567" }, { hashSenha })).toEqual({ ok: false, reason: "senha_curta" });
    await usuario(TEAM_B, "ja.b@exemplo.com.br");
    const deOutro = await convite(TEAM_A, "ja.b@exemplo.com.br");
    expect(await aceitarConviteComSenha(deOutro, { name: "x", senha: "senha-boa-123" }, { hashSenha })).toEqual({ ok: false, reason: "email_in_other_team" });
    expect(hashSenha).not.toHaveBeenCalled();

    // Caminho feliz: hash uma vez, usuário no time do convite.
    const bom = await convite(TEAM_A, "nova.pessoa@exemplo.com.br");
    const ok = await aceitarConviteComSenha(bom, { name: "Nova", senha: "senha-boa-123" }, { ip, hashSenha });
    expect(ok).toMatchObject({ ok: true, teamId: TEAM_A });
    expect(hashSenha).toHaveBeenCalledTimes(1);
    const u = await basePrisma.user.findUniqueOrThrow({ where: { email: "nova.pessoa@exemplo.com.br" } });
    expect(u.passwordHash).toBe("hash(senha-boa-123)");

    // Limite por IP (a mesma chave do acceptInvite): 10 por janela, contando as 2 acima.
    for (let i = 0; i < 8; i++) await aceitarConviteComSenha("inv_inexistente", { name: "x", senha: "senha-boa-123" }, { ip, hashSenha });
    expect(await aceitarConviteComSenha(bom, { name: "x", senha: "senha-boa-123" }, { ip, hashSenha })).toEqual({ ok: false, reason: "rate_limited" });
    expect(hashSenha).toHaveBeenCalledTimes(1);
  });

  it("aceite NUNCA troca a senha de quem já tem conta (a porta admin → dono)", async () => {
    const token = await convite(TEAM_A, "dono@exemplo.com.br");
    const dono = await usuario(TEAM_A, "dono@exemplo.com.br");
    const res = await acceptInvite(token, { name: "Invasor", passwordHash: "hash-do-admin" });
    expect(res).toEqual({ ok: false, reason: "email_ja_cadastrado" });
    const depois = await basePrisma.user.findUniqueOrThrow({ where: { id: dono.id } });
    expect(depois.passwordHash).toBe("hash-original");
    expect(depois.name).toBe("dono@exemplo.com.br");
  });

  it("aceite duplo: o segundo falha (sequencial)", async () => {
    const token = await convite(TEAM_A, "novo@exemplo.com.br");
    const um = await acceptInvite(token, { name: "Novo", passwordHash: "h1" });
    const dois = await acceptInvite(token, { name: "Novo", passwordHash: "h2" });
    expect(um.ok).toBe(true);
    expect(dois.ok).toBe(false);
    const u = await basePrisma.user.findUniqueOrThrow({ where: { email: "novo@exemplo.com.br" } });
    expect(u.passwordHash).toBe("h1");
  });

  it("aceite duplo SIMULTÂNEO: exatamente um vence e só um usuário nasce", async () => {
    const token = await convite(TEAM_A, "corrida@exemplo.com.br");
    const res = await Promise.all([
      acceptInvite(token, { name: "A", passwordHash: "ha" }),
      acceptInvite(token, { name: "B", passwordHash: "hb" }),
    ]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(await basePrisma.user.count({ where: { email: "corrida@exemplo.com.br" } })).toBe(1);
  });

  it("aceite com IP respeita o limite por IP", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}-${unico()}`;
    for (let i = 0; i < 10; i++) await acceptInvite("inv_inexistente", { name: "x", passwordHash: "h" }, { ip });
    const res = await acceptInvite("inv_inexistente", { name: "x", passwordHash: "h" }, { ip });
    expect(res).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("reset de senha (S12)", () => {
  async function tokenDeReset(userId: string) {
    const token = `rst_${randomUUID()}`;
    await basePrisma.passwordResetToken.create({
      data: { userId, tokenHash: sha(token), expiresAt: new Date(Date.now() + 60_000) },
    });
    return token;
  }

  it("troca a senha, sobe a sessionVersion e derruba a sessão na hora", async () => {
    const u = await usuario(TEAM_A, `reset.${unico()}@exemplo.com.br`);
    const tokenJwt = { teamId: TEAM_A, role: "owner", sessionVersion: u.sessionVersion };
    // Sessão válida antes (e o estado fica no cache).
    expect(sessionIsCurrent(tokenJwt, await getSessionState(u.id))).toBe(true);

    expect(await consumePasswordReset(await tokenDeReset(u.id), "hash-nova")).toBe(true);

    const depois = await basePrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(depois.passwordHash).toBe("hash-nova");
    expect(depois.sessionVersion).toBe(u.sessionVersion + 1);
    // O cache foi apagado: a sessão antiga cai já na próxima request.
    expect(sessionIsCurrent(tokenJwt, await getSessionState(u.id))).toBe(false);
  });

  it("redefinirSenhaComToken: token inválido, senha curta e limite barram ANTES do bcrypt", async () => {
    const hashSenha = vi.fn(async (s: string) => `hash(${s})`);
    const u = await usuario(TEAM_A, `reset.puro.${unico()}@exemplo.com.br`);
    const ip = `203.0.113.${unico()}`;
    expect(await redefinirSenhaComToken("rst_inexistente", "senha-nova-123", { ip, hashSenha })).toEqual({ ok: false, reason: "invalid" });
    const token = await tokenDeReset(u.id);
    expect(await redefinirSenhaComToken(token, "curta", { hashSenha })).toEqual({ ok: false, reason: "senha_curta" });
    expect(hashSenha).not.toHaveBeenCalled();

    expect(await redefinirSenhaComToken(token, "senha-nova-123", { ip, hashSenha })).toEqual({ ok: true });
    expect((await basePrisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe("hash(senha-nova-123)");
    expect(await redefinirSenhaComToken(token, "outra-senha-123", { hashSenha })).toEqual({ ok: false, reason: "invalid" });
    expect(hashSenha).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 8; i++) await redefinirSenhaComToken("rst_inexistente", "senha-nova-123", { ip, hashSenha });
    expect(await redefinirSenhaComToken(await tokenDeReset(u.id), "senha-nova-123", { ip, hashSenha })).toEqual({ ok: false, reason: "rate_limited" });
    expect(hashSenha).toHaveBeenCalledTimes(1);
  });

  it("dois cliques simultâneos no link: uma troca só", async () => {
    const u = await usuario(TEAM_A, `reset2.${unico()}@exemplo.com.br`);
    const token = await tokenDeReset(u.id);
    const res = await Promise.all([consumePasswordReset(token, "h-a"), consumePasswordReset(token, "h-b")]);
    expect(res.filter(Boolean)).toHaveLength(1);
    const depois = await basePrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(depois.sessionVersion).toBe(u.sessionVersion + 1);
  });
});

describe("sessão (S12)", () => {
  it("token bate com o banco → vale; papel, time ou versão diferentes → cai", async () => {
    const u = await usuario(TEAM_A, `sess.${unico()}@exemplo.com.br`, "admin");
    const estado = await getSessionState(u.id);
    const ok = { teamId: TEAM_A, role: "admin", sessionVersion: u.sessionVersion };
    expect(sessionIsCurrent(ok, estado)).toBe(true);
    expect(sessionIsCurrent({ ...ok, role: "owner" }, estado)).toBe(false);
    expect(sessionIsCurrent({ ...ok, teamId: TEAM_B }, estado)).toBe(false);
    expect(sessionIsCurrent({ ...ok, sessionVersion: u.sessionVersion + 1 }, estado)).toBe(false);
    // Token emitido antes desta mudança (sem versão) não vale mais.
    expect(sessionIsCurrent({ teamId: TEAM_A, role: "admin" }, estado)).toBe(false);
  });

  it("revokeUserSessions derruba na hora; usuário removido também cai", async () => {
    const u = await usuario(TEAM_A, `sess2.${unico()}@exemplo.com.br`);
    const tok = { teamId: TEAM_A, role: "owner", sessionVersion: u.sessionVersion };
    expect(sessionIsCurrent(tok, await getSessionState(u.id))).toBe(true);
    await revokeUserSessions(u.id);
    expect(sessionIsCurrent(tok, await getSessionState(u.id))).toBe(false);

    const v = await usuario(TEAM_A, `sess3.${unico()}@exemplo.com.br`);
    await basePrisma.user.delete({ where: { id: v.id } });
    expect(await getSessionState(v.id)).toBeNull();
  });
});

describe("limite de login (S8; só falhas — auditoria do #52)", () => {
  /** Uma tentativa como o `authorize` faz: consulta, "bcrypt", registra o resultado. */
  async function tentar(ip: string | null, email: string, certa: boolean) {
    const rl = await checkLoginRateLimit({ ip, email });
    if (!rl.allowed) return "barrada" as const;
    if (certa) await registrarSucessoDeLogin({ ip, email });
    else await registrarFalhaDeLogin({ ip, email });
    return certa ? ("entrou" as const) : ("errou" as const);
  }

  it("acerto não gasta tentativa: o dono entra 15× seguidas do mesmo IP", async () => {
    const email = `dono.${unico()}@exemplo.com.br`;
    const ip = `198.51.100.${unico()}`;
    for (let i = 0; i < 15; i++) expect(await tentar(ip, email, true), `login ${i + 1}`).toBe("entrou");
  });

  it("10 erros do atacante (um IP) barram só o atacante: o dono, de outro IP, entra", async () => {
    const email = `dono.${unico()}@exemplo.com.br`;
    const atacante = `198.51.100.${unico()}`;
    for (let i = 0; i < LOGIN_LIMITES.falhasPorEmailEIp.max; i++) expect(await tentar(atacante, email, false)).toBe("errou");
    const bloqueada = await checkLoginRateLimit({ ip: atacante, email });
    expect(bloqueada.allowed).toBe(false);
    expect(bloqueada.retryAfterMs).toBeGreaterThan(0);
    expect(await tentar(`203.0.113.${unico()}`, email, true)).toBe("entrou");
  });

  it("acerto zera os erros de digitação do próprio par", async () => {
    const email = `dono.${unico()}@exemplo.com.br`;
    const ip = `198.51.100.${unico()}`;
    for (let i = 0; i < LOGIN_LIMITES.falhasPorEmailEIp.max - 1; i++) await tentar(ip, email, false);
    expect(await tentar(ip, email, true)).toBe("entrou");
    for (let i = 0; i < LOGIN_LIMITES.falhasPorEmailEIp.max - 1; i++) expect(await tentar(ip, email, false)).toBe("errou");
  });

  it("força bruta distribuída: 50 erros de vários IPs barram o e-mail", async () => {
    const email = `alvo.${unico()}@exemplo.com.br`;
    for (let i = 0; i < LOGIN_LIMITES.falhasPorEmail.max; i++) {
      expect(await tentar(`198.51.${i % 5}.${unico()}`, email, false)).toBe("errou");
    }
    expect(await tentar(`203.0.113.${unico()}`, email, true)).toBe("barrada");
  });

  it("21ª falha do mesmo IP (e-mails diferentes) é barrada; acertos do IP não contam como falha", async () => {
    const ip = `198.51.100.${unico()}`;
    for (let i = 0; i < 5; i++) expect(await tentar(ip, `certo${i}.${unico()}@e.com`, true)).toBe("entrou");
    for (let i = 0; i < LOGIN_LIMITES.falhasPorIp.max; i++) expect(await tentar(ip, `x${i}.${unico()}@e.com`, false)).toBe("errou");
    expect(await tentar(ip, `y.${unico()}@e.com`, true)).toBe("barrada");
  });

  it("teto de CPU por IP conta toda tentativa (60 / 15 min)", async () => {
    const ip = `198.51.100.${unico()}`;
    for (let i = 0; i < LOGIN_LIMITES.tentativasPorIp.max; i++) {
      expect((await checkLoginRateLimit({ ip, email: `z${i}.${unico()}@e.com` })).allowed).toBe(true);
    }
    expect((await checkLoginRateLimit({ ip, email: `z.${unico()}@e.com` })).allowed).toBe(false);
  });

  it("peekRateLimit consulta sem consumir", async () => {
    const chave = `teste:peek:${unico()}`;
    await rateLimit(chave, 2, 60_000);
    expect((await peekRateLimit(chave, 2, 60_000)).allowed).toBe(true);
    expect((await peekRateLimit(chave, 2, 60_000)).allowed).toBe(true);
    await rateLimit(chave, 2, 60_000);
    expect((await peekRateLimit(chave, 2, 60_000)).allowed).toBe(false);
  });
});
