import { teamConfigUpdateSchema, getTeamConfig, updateTeamConfig, requireRole } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/configuracoes/business-hours — config de horário comercial/feriados
 * do time (ou os defaults se a row ainda não existir). Sem sessão → 401.
 */
export async function GET() {
  return withTeam(() => getTeamConfig());
}

/**
 * PUT /api/configuracoes/business-hours — atualiza (parcial) a config do time.
 * Corpo: { respectBusinessHours?, businessHourStart?, businessHourEnd?,
 * businessDays?, respectHolidays?, timezone? }. Validação zod nas bordas.
 * Devolve a config resultante.
 */
export async function PUT(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    requireRole("admin"); // RBAC: configurar horário do time exige admin+ (fail-closed).
    const data = teamConfigUpdateSchema.parse(body);
    return updateTeamConfig(data);
  });
}
