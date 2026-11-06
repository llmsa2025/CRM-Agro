import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam, SYSTEM_USER_ID, SYSTEM_ROLE } from "@crmagro/db";
import { ForbiddenError, requireCan, can } from "./authz";
import { temModulo, normalizarModulos, moduloDaAcao } from "./modulos";
import { definirModulos, AcaoNaoPermitida } from "./equipe";
import { createInvite, acceptInvite } from "./invites";
import { getSessionState } from "./session";
import { toolsForMode, toolsParaTelas } from "../ai/tools";

/**
 * Telas por pessoa (plano-equipe-permissoes F2b): a ação sem a tela é negada
 * mesmo que o papel permita; master/admin veem tudo; vazio = todas; o Painel
 * sempre; o sistema (motor/webhook) passa.
 */
const TEAM = "00000000-0000-0000-0000-00000000f2b1";
const sufixo = Math.random().toString(36).slice(2, 7);
let dono: { id: string }, vendedor: { id: string }, gestor: { id: string };

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Telas (test)" } });
  await basePrisma.invite.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
  const mk = (nome: string, role: string) =>
    basePrisma.user.create({ data: { teamId: TEAM, name: nome, email: `${nome}-${sufixo}@telas.dev`, role, emailVerificadoEm: new Date() } });
  dono = await mk("dono", "owner");
  vendedor = await mk("vendedor", "member");
  gestor = await mk("gestor", "admin");
});
afterAll(async () => {
  await basePrisma.invite.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
});

describe("telas por pessoa: regra", () => {
  it("vazio = todas; o Painel sempre; master/admin ignoram a lista", () => {
    expect(temModulo("member", [], "campanhas")).toBe(true);
    expect(temModulo("member", ["contatos"], "campanhas")).toBe(false);
    expect(temModulo("member", ["contatos"], "painel")).toBe(true);
    expect(temModulo("admin", ["contatos"], "campanhas")).toBe(true);
    expect(temModulo("owner", ["contatos"], "integracoes")).toBe(true);
    expect(normalizarModulos(["contatos", "voar", "contatos"])).toEqual(["painel", "contatos"]);
    expect(normalizarModulos([])).toEqual([]);
    // Todas marcadas = vazio (acompanha telas novas).
    expect(normalizarModulos(["painel", "atividades", "conversas", "ligacoes", "agenda", "contatos", "campanhas", "captacao", "funis", "fluxos", "mapa", "integracoes", "configuracoes"])).toEqual([]);
    expect(moduloDaAcao("campaigns.start")).toBe("campanhas");
    expect(moduloDaAcao("push.subscribe")).toBeNull();
  });

  it("requireCan: membro sem a tela é negado mesmo com o papel; com a tela passa; sistema e admin passam", () => {
    const membro = { userId: vendedor.id, role: "member", modulos: ["painel", "contatos"] };
    expect(() => runWithTeam(TEAM, () => requireCan("campaigns.write"), membro)).toThrow(ForbiddenError);
    expect(runWithTeam(TEAM, () => can("campaigns.write"), membro)).toBe(false);
    expect(runWithTeam(TEAM, () => requireCan("contacts.write"), membro)).toMatchObject({ role: "member" });
    // Ação sem tela (avisos do navegador) vale em qualquer lugar.
    expect(runWithTeam(TEAM, () => requireCan("push.subscribe"), membro)).toMatchObject({ role: "member" });
    // Lista vazia = todas.
    expect(runWithTeam(TEAM, () => requireCan("campaigns.write"), { userId: vendedor.id, role: "member", modulos: [] })).toBeTruthy();
    // Administrador com lista (não deveria ter) vê tudo mesmo assim.
    expect(runWithTeam(TEAM, () => requireCan("campaigns.write"), { userId: gestor.id, role: "admin", modulos: ["contatos"] })).toBeTruthy();
    // Sistema (motor/webhook) não tem tela.
    expect(runWithTeam(TEAM, () => requireCan("campaigns.start"), { userId: SYSTEM_USER_ID, role: SYSTEM_ROLE, modulos: ["contatos"] })).toBeTruthy();
  });
});

describe("telas por pessoa: equipe", () => {
  it("administrador define as telas de um membro (normaliza, Painel incluso) e a sessão cai", async () => {
    const antes = await basePrisma.user.findUniqueOrThrow({ where: { id: vendedor.id } });
    const r = await runWithTeam(TEAM, () => definirModulos(vendedor.id, ["contatos", "funis", "xyz"]), { userId: gestor.id, role: "admin" });
    expect(r.modulos).toEqual(["painel", "contatos", "funis"]);
    expect((await getSessionState(vendedor.id))?.sessionVersion).toBe(antes.sessionVersion + 1);
  });

  it("administrador não tem lista de telas; membro não define telas", async () => {
    await expect(runWithTeam(TEAM, () => definirModulos(gestor.id, ["contatos"]), { userId: dono.id, role: "owner" })).rejects.toBeInstanceOf(AcaoNaoPermitida);
    await expect(runWithTeam(TEAM, () => definirModulos(vendedor.id, []), { userId: vendedor.id, role: "member" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("convite leva as telas (normalizadas) e o convidado nasce com elas", async () => {
    const c = await runWithTeam(TEAM, () => createInvite({ email: `novo-${sufixo}@telas.dev`, modulos: ["mapa", "contatos"] }), { userId: dono.id, role: "owner" });
    expect((await acceptInvite(c.token, { name: "Novo", passwordHash: "hash:x" })).ok).toBe(true);
    const novo = await basePrisma.user.findUniqueOrThrow({ where: { email: `novo-${sufixo}@telas.dev` } });
    expect(novo.modulos).toEqual(["painel", "contatos", "mapa"]);
  });
});

describe("telas por pessoa: assistente de IA", () => {
  it("sem a tela Contatos, o assistente fica só com CNPJ e busca na web", () => {
    const todas = toolsForMode("read_write");
    expect(todas.some((t) => t.def.name === "search_contacts")).toBe(true);
    const sem = toolsParaTelas(todas, false).map((t) => t.def.name);
    expect(sem.every((n) => n === "lookup_cnpj" || n === "web_search")).toBe(true);
    expect(sem).toContain("lookup_cnpj");
    expect(toolsParaTelas(todas, true)).toHaveLength(todas.length);
  });
});
