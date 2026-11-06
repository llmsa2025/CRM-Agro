import { z } from "zod";
import { getDashboardData } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard — KPIs + lista do dia + atividade da semana + funis.
 *   ?period=hoje|semana|mes  janela dos KPIs/atividade (default semana)
 */
const querySchema = z.object({
  period: z.enum(["hoje", "semana", "mes"]).default("semana"),
});

export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(async () => {
    const { period } = querySchema.parse(params);
    return getDashboardData(period);
  });
}
