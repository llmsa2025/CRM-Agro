import { runWithTeam as runWithTeamDb } from "@crmagro/db";

/**
 * Helper SÓ de teste. Desde o RBAC nos serviços (auditoria S7), todo serviço de
 * escrita exige papel no contexto (fail-closed). Os testes de domínio não são
 * sobre papel, então entram como DONO por padrão. Quem testa papel passa a
 * identidade explícita (ex.: `{ userId, role: "viewer" }`).
 */
export const DONO_TESTE = { userId: "dono-teste", role: "owner" } as const;

export function runWithTeam<T>(
  teamId: string,
  fn: () => T,
  identity: { userId?: string; role?: string; verTudoEm?: readonly string[]; editarTudoEm?: readonly string[] } = DONO_TESTE,
): T {
  return runWithTeamDb(teamId, fn, identity);
}
