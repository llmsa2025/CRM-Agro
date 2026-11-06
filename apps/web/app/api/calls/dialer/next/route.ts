import { getNextDialerSlot } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/calls/dialer/next — próximo contato a ligar no discador.
 *
 * Cria uma Call com status `scheduled` e retorna o slot (card do SDR).
 * Retorna `null` quando não há contatos pendentes ou, se
 * `respectBusinessHours=true`, fora do horário comercial.
 */
export async function POST() {
  return withTeam(async () => {
    return getNextDialerSlot();
  });
}
