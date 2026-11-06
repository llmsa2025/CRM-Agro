import { describe, it, expect } from "vitest";
import { runWithTeam, runAsSystem, SYSTEM_USER_ID, SYSTEM_ROLE } from "@crmagro/db";
import {
  getActor,
  requireRole,
  requireCan,
  can,
  hasRole,
  roleAtLeast,
  ForbiddenError,
} from "./authz";

// teamId de teste (hex válido) — não colide com o seed.
const TEAM = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000a2";

describe("authz — fail-closed (a defesa de RBAC)", () => {
  it("SEM contexto de tenancy: getActor null, requireRole lança, can false", () => {
    expect(getActor()).toBeNull();
    expect(() => requireRole("viewer")).toThrow(ForbiddenError);
    expect(can("team.invite")).toBe(false);
    expect(hasRole("viewer")).toBe(false);
  });

  it("contexto SÓ com teamId (sem identidade/papel): NEGA tudo", () => {
    runWithTeam(TEAM, () => {
      // Retrocompat: quem só passa teamId não tem papel → fail-closed.
      expect(getActor()).toBeNull();
      expect(() => requireRole("viewer")).toThrow(ForbiddenError);
      expect(can("settings.write")).toBe(false);
    });
  });

  it("papel DESCONHECIDO no contexto → tratado como ausente (nega)", () => {
    runWithTeam(TEAM, () => {
      expect(getActor()).toBeNull();
      expect(() => requireRole("viewer")).toThrow(ForbiddenError);
    }, { userId: USER, role: "superuser" });
  });

  it("member NÃO pode ações de admin (convite/config/integrações)", () => {
    runWithTeam(TEAM, () => {
      const actor = getActor();
      expect(actor?.role).toBe("member");
      expect(() => requireRole("admin")).toThrow(ForbiddenError);
      expect(can("team.invite")).toBe(false);
      expect(can("settings.write")).toBe(false);
      expect(can("integrations.manage")).toBe(false);
      // mas pode o que é de member p/ baixo
      expect(hasRole("member")).toBe(true);
      expect(hasRole("viewer")).toBe(true);
    }, { userId: USER, role: "member" });
  });

  it("admin pode convidar/configurar, mas NÃO billing/excluir time (owner-only)", () => {
    runWithTeam(TEAM, () => {
      expect(() => requireRole("admin")).not.toThrow();
      expect(can("team.invite")).toBe(true);
      expect(can("settings.businessHours")).toBe(true);
      expect(can("integrations.manage")).toBe(true);
      expect(can("team.billing")).toBe(false);
      expect(can("team.delete")).toBe(false);
    }, { userId: USER, role: "admin" });
  });

  it("owner pode tudo, incl. billing/excluir time", () => {
    runWithTeam(TEAM, () => {
      expect(() => requireCan("team.billing")).not.toThrow();
      expect(() => requireCan("team.delete")).not.toThrow();
      expect(can("team.invite")).toBe(true);
    }, { userId: USER, role: "owner" });
  });

  it("viewer só tem o piso da hierarquia", () => {
    runWithTeam(TEAM, () => {
      expect(hasRole("viewer")).toBe(true);
      expect(hasRole("member")).toBe(false);
      expect(() => requireRole("member")).toThrow(ForbiddenError);
    }, { userId: USER, role: "viewer" });
  });

  it("ação DESCONHECIDA exige owner (default restritivo)", () => {
    runWithTeam(TEAM, () => {
      expect(can("acao.inexistente")).toBe(false); // admin não basta
    }, { userId: USER, role: "admin" });
    runWithTeam(TEAM, () => {
      expect(can("acao.inexistente")).toBe(true); // owner sim
    }, { userId: USER, role: "owner" });
  });

  it("roleAtLeast (comparação pura, sem ALS) é fail-closed", () => {
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
    expect(roleAtLeast("banana", "viewer")).toBe(false);
  });
});

/**
 * Tabela papel × ação (auditoria S7 — item 0.3). Uma linha por ação nova: o
 * menor papel que PODE. Tudo abaixo dele é negado.
 */
describe("authz — tabela papel × ação (S7)", () => {
  const TABELA: Array<[string, "viewer" | "member" | "admin" | "owner"]> = [
    ["contacts.write", "member"],
    ["contacts.import", "member"],
    ["contacts.delete", "admin"],
    ["contacts.export", "admin"],
    ["contacts.merge", "admin"],
    ["flows.write", "member"],
    ["flows.activate", "admin"],
    ["funnels.write", "member"],
    ["deals.write", "member"],
    ["messages.send", "member"],
    ["conversations.delete", "admin"],
    ["tags.write", "member"],
    ["agenda.write", "member"],
    ["calls.write", "member"],
    ["calls.lines.manage", "admin"],
    ["tasks.write", "member"],
    ["campaigns.write", "member"],
    ["campaigns.start", "member"],
    ["captacao.run", "member"],
    ["captacao.import", "member"],
    ["captacao.fonte_paga", "admin"],
    ["ai.write", "member"],
    ["relay.tokens", "admin"],
    ["social.connect", "admin"],
    ["integrations.manage", "admin"],
    ["conhecimento.write", "admin"],
    ["metodologias.write", "admin"],
    ["settings.goals", "admin"],
    ["settings.businessHours", "admin"],
    ["team.invite", "admin"],
  ];
  const ORDEM = ["viewer", "member", "admin", "owner"] as const;

  for (const [acao, minimo] of TABELA) {
    it(`${acao}: a partir de ${minimo}`, () => {
      for (const papel of ORDEM) {
        const pode = ORDEM.indexOf(papel) >= ORDEM.indexOf(minimo);
        runWithTeam(TEAM, () => expect(can(acao), `${papel} → ${acao}`).toBe(pode), { userId: USER, role: papel });
      }
    });
  }

  it("viewer não escreve em nada da operação", () => {
    runWithTeam(TEAM, () => {
      for (const [acao] of TABELA) expect(can(acao), acao).toBe(false);
    }, { userId: USER, role: "viewer" });
  });
});

describe("authz — identidade do sistema (motor, webhooks, jobs)", () => {
  it("runAsSystem age com poder de dono DENTRO do time e se identifica como sistema", () => {
    runAsSystem(TEAM, () => {
      const ator = getActor();
      expect(ator).toEqual({ teamId: TEAM, userId: SYSTEM_USER_ID, role: "owner", system: true });
      expect(can("flows.activate")).toBe(true);
    });
  });

  it("só vale com userId E papel de sistema juntos (usuário não se passa por sistema)", () => {
    runWithTeam(TEAM, () => expect(getActor()).toBeNull(), { userId: USER, role: SYSTEM_ROLE });
    runWithTeam(TEAM, () => expect(getActor()?.system).toBeUndefined(), { userId: SYSTEM_USER_ID, role: "member" });
  });

  it("sem identidade continua negado (não virou 'sistema' por omissão)", () => {
    runWithTeam(TEAM, () => {
      expect(getActor()).toBeNull();
      expect(can("contacts.write")).toBe(false);
    });
  });
});
