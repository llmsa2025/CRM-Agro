import { markCallOutcome, callOutcomeSchema } from "@crmagro/core";
import { z } from "zod";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dialerOutcomeSchema = z.object({
  callId: z.string().uuid(),
  outcome: callOutcomeSchema,
  durationSec: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

/**
 * POST /api/calls/dialer/outcome — registra o resultado de uma ligação.
 *   { callId: uuid,
 *     outcome: "answered" | "no_answer" | "busy" | "voicemail" | "wrong_number" | "skip",
 *     durationSec?: number,
 *     notes?: string }
 *
 * Atualiza o status da Call e cria uma Activity de rastreabilidade. Caixa
 * postal marca o retorno em 2 dias úteis; número errado invalida o número do
 * contato (produto §D). Erros de domínio (CallNotFound → 404, CallValidationError → 400) são
 * mapeados pelo `withTeam`.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    const { callId, outcome, durationSec, notes } = dialerOutcomeSchema.parse(body);
    await markCallOutcome(callId, outcome, { durationSec, notes });
    return { ok: true };
  });
}
