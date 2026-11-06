import { describe, it, expect, afterAll } from "vitest";
import { ZodError } from "zod";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { ForbiddenError } from "./authz";
import { provisionUserFromGoogle } from "./provisioning";
import { getSessionState } from "./session";
import { createInvite, acceptInvite } from "./invites";
import { getEmpresa, atualizarEmpresa } from "./empresa";
import { seedNewTeam } from "./seed-time";

/**
 * Empresa (plano-equipe-permissoes F1): criar a conta da empresa pelo Google,
 * a proteção contra conta com senha NÃO comprovada (convite aceito pelo link,
 * script, contas de antes da confirmação obrigatória) e Configurações →
 * Empresa (RBAC e dois times).
 *
 * A criação com e-mail e senha (com confirmação do e-mail) tem o próprio
 * arquivo: cadastro-com-senha.test.ts.
 */
const sufixo = Math.random().toString(36).slice(2, 8);
const email = (n: string) => `empresa-${n}-${sufixo}@crmagro.example`;
const criados: string[] = [];

afterAll(async () => {
  for (const teamId of criados) {
    await basePrisma.goal.deleteMany({ where: { teamId } });
    await basePrisma.stage.deleteMany({ where: { teamId } });
    await basePrisma.funnel.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
    await basePrisma.team.deleteMany({ where: { id: teamId } });
  }
});

/**
 * Time com dono por senha e e-mail NÃO comprovado — como uma conta de script
 * ou de antes da confirmação obrigatória (o cadastro de hoje nasce comprovado).
 */
async function criar(n: string) {
  const team = await basePrisma.team.create({ data: { name: `Fazenda ${n}` } });
  const user = await basePrisma.user.create({
    data: { teamId: team.id, name: `Dono ${n}`, email: email(n), role: "owner", passwordHash: "hash:senha-forte-123", emailVerificadoEm: null },
  });
  await basePrisma.team.update({ where: { id: team.id }, data: { masterId: user.id } });
  await seedNewTeam(team.id, user.id);
  criados.push(team.id);
  return { userId: user.id, teamId: team.id };
}

describe("Google e a conta criada com e-mail alheio", () => {
  it("convite aceito com senha NÃO comprova o e-mail: o login Google do dono real apaga a senha (B2)", async () => {
    const dono = await criar("k");
    const convite = await runWithTeam(dono.teamId, () => createInvite({ email: email("vitima") }), { userId: dono.userId, role: "owner" });
    const res = await acceptInvite(convite.token, { name: "Quem abriu o link", passwordHash: "hash:do-invasor" });
    expect(res.ok).toBe(true);
    const conta = await basePrisma.user.findUniqueOrThrow({ where: { email: email("vitima") } });
    expect(conta.emailVerificadoEm).toBeNull();
    const g = await provisionUserFromGoogle({ email: email("vitima") });
    expect(g.sessionVersion).toBe(conta.sessionVersion + 1);
    expect((await basePrisma.user.findUniqueOrThrow({ where: { id: conta.id } })).passwordHash).toBeNull();
  });

  it("conta por senha não comprovada: o login Google apaga a senha, derruba as sessões e comprova o e-mail", async () => {
    const r = await criar("f");
    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    // Quem criou está logado: o estado da sessão dele está no cache (60 s).
    expect((await getSessionState(r.userId))?.sessionVersion).toBe(antes.sessionVersion);
    const g = await provisionUserFromGoogle({ email: email("f"), name: "Dono de verdade" });
    expect(g).toMatchObject({ userId: r.userId, teamId: r.teamId, sessionVersion: antes.sessionVersion + 1 });
    const depois = await basePrisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(depois.passwordHash).toBeNull();
    expect(depois.emailVerificadoEm).not.toBeNull();
    // O cache da sessão foi limpo: a checagem seguinte já vê a versão nova
    // (a sessão de quem criou cai; a do dono de verdade vale).
    const estado = await getSessionState(r.userId);
    expect(estado?.sessionVersion).toBe(antes.sessionVersion + 1);
  });

  it("conta já comprovada: o Google entra sem mexer na senha nem nas sessões", async () => {
    const r = await criar("g");
    await basePrisma.user.update({ where: { id: r.userId }, data: { emailVerificadoEm: new Date() } });
    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    const g = await provisionUserFromGoogle({ email: email("g") });
    expect(g.sessionVersion).toBe(antes.sessionVersion);
    expect((await basePrisma.user.findUniqueOrThrow({ where: { id: r.userId } })).passwordHash).toBe("hash:senha-forte-123");
  });

  it("criar a empresa pelo Google: time com o nome da empresa, dono comprovado e os padrões", async () => {
    const g = await provisionUserFromGoogle(
      { email: email("h"), name: "Dona H" },
      { cadastroAberto: true, empresa: { nome: "Agro H", cidade: "Sinop", estado: "MT" } },
    );
    criados.push(g.teamId);
    expect(await basePrisma.team.findUniqueOrThrow({ where: { id: g.teamId } })).toMatchObject({ name: "Agro H", cidade: "Sinop", estado: "MT", masterId: g.userId });
    const dona = await basePrisma.user.findUniqueOrThrow({ where: { id: g.userId } });
    expect(dona.role).toBe("owner");
    expect(dona.emailVerificadoEm).not.toBeNull();
    expect(await basePrisma.stage.count({ where: { teamId: g.teamId } })).toBe(5);
  });
});

describe("Configurações → Empresa", () => {
  it("dono e admin editam; membro não; cada time mexe só na própria empresa", async () => {
    const a = await criar("i");
    const b = await criar("j");
    const comoA = <T>(role: string, fn: () => Promise<T>) => runWithTeam(a.teamId, fn, { userId: a.userId, role });

    await expect(comoA("member", () => atualizarEmpresa({ nome: "Invadida" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(comoA("member", () => getEmpresa())).resolves.toMatchObject({ nome: "Fazenda i" });

    const nova = await comoA("admin", () => atualizarEmpresa({ nome: "Fazenda I Ltda", cnpj: "", cidade: "Lucas do Rio Verde", estado: "mt" }));
    expect(nova).toEqual({ id: a.teamId, nome: "Fazenda I Ltda", cnpj: null, cidade: "Lucas do Rio Verde", estado: "MT" });
    // O time B não foi tocado.
    expect(await basePrisma.team.findUniqueOrThrow({ where: { id: b.teamId } })).toMatchObject({ name: "Fazenda j", cidade: null });
    await expect(comoA("owner", () => atualizarEmpresa({ nome: "X", estado: "MTT" }))).rejects.toBeInstanceOf(ZodError);
  });
});
