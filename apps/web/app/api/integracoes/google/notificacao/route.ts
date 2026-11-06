import { NextResponse } from "next/server";
import { receberAvisoDoGoogle, logger } from "@crmagro/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Aviso de mudança do Google Agenda (events.watch). PÚBLICA (o Google não tem
 * sessão; liberada no middleware): o canal e o token (HMAC do id do canal) são
 * conferidos no core ANTES de qualquer coisa, e o aviso só enfileira a
 * sincronização (o worker busca a mudança pelo cursor). Sem corpo.
 *
 * 200 sempre que o aviso foi tratado ou ignorado (canal desconhecido, token
 * errado — nada a revelar); 503 só em falha nossa (Redis fora), para o
 * Google tentar de novo.
 */
export async function POST(req: Request) {
  const h = req.headers;
  try {
    await receberAvisoDoGoogle({
      canalId: h.get("x-goog-channel-id"),
      token: h.get("x-goog-channel-token"),
      resourceId: h.get("x-goog-resource-id"),
      estado: h.get("x-goog-resource-state"),
    });
    return new NextResponse(null, { status: 200 });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message.slice(0, 120) : "erro" }, "[agenda-google] aviso do Google não enfileirado");
    return new NextResponse(null, { status: 503 });
  }
}
