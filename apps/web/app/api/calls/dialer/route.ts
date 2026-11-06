import { startDialerSession, getDialerStats } from "@crmagro/core";
import { z } from "zod";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startDialerSchema = z.object({
  respectBusinessHours: z.boolean().optional().default(false),
});

/**
 * POST /api/calls/dialer — inicia (ou recupera) a sessão do discador do dia.
 *   { respectBusinessHours?: boolean }  default false
 *
 * `respectBusinessHours=false` (default) permite ligar em qualquer horário;
 * `true` respeita o motor do dia (`canCallNow()`).
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    const { respectBusinessHours } = startDialerSchema.parse(body);
    return startDialerSession({ respectBusinessHours });
  });
}

/**
 * GET /api/calls/dialer — estatísticas da sessão do discador (hoje).
 * Calculadas dinamicamente das Calls — não depende de sessão em memória.
 */
export async function GET() {
  return withTeam(async () => {
    return getDialerStats();
  });
}
