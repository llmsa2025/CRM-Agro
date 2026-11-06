/**
 * Beta do Nectar por time. Só os times liberados veem a integração.
 *
 * "Liberado" é a lista `CRM_BETA_TEAM_IDS` do `.env` (ids de time; `todos` libera geral), lida NA HORA da chamada e não
 * o `env` do `@crmagro/config`, que é lido uma vez no boot, para os testes poderem mudar o valor. Sem lista, "não".
 */
import { timesDoBetaCrm } from "@crmagro/config";
import { getCurrentTeamId } from "@crmagro/db";
import { CrmForaDoBeta } from "../errors";

/** O time está liberado no beta? Sem time no contexto é "não" (fail-closed). */
export function crmLiberadoParaOTime(teamId: string | null | undefined = getCurrentTeamId()): boolean {
  if (!teamId) return false;
  const lista = timesDoBetaCrm(process.env.CRM_BETA_TEAM_IDS);
  return lista.todos || lista.ids.has(teamId.trim().toLowerCase());
}

/** Mantida para quem chama antes do gate: a leitura é do `.env`, então não há nada para esperar. */
export async function aquecerBetaCrm(teamId?: string | null): Promise<void> {
  void teamId;
}

/** Lança `CrmForaDoBeta` quando o time do contexto não está no beta. */
export async function exigirBetaCrm(): Promise<void> {
  if (!crmLiberadoParaOTime()) throw new CrmForaDoBeta();
}
