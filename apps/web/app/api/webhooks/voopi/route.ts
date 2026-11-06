import { NextResponse } from "next/server";
import { VoopiProvider } from "@crmagro/channels";
import { applyVoopiWebhookEvent, autenticarWebhookVoopi } from "@crmagro/core";

/**
 * Webhook da Voopi (tronco SIP / click-to-call).
 *
 * A Voopi envia eventos de ciclo de vida da chamada para este endpoint:
 * - call.answered: contato atendeu → status = answered
 * - call.ended: chamada terminou → status = completed + durationSeconds
 * - call.recording: gravação disponível → recordingUrl na Call
 *
 * Autenticação (`autenticarWebhookVoopi`, core):
 *  - `?ref=<callId>&sig=<HMAC>`: o callbackUrl de cada ligação (ligarPelaVoopi).
 *    A assinatura vale só para aquela ligação — o segredo global nunca vai
 *    para a conta Voopi do time;
 *  - `?token=` ou header `x-webhook-token` com o VOOPI_WEBHOOK_TOKEN: webhook
 *    configurado à mão no painel da Voopi.
 * Sem VOOPI_WEBHOOK_TOKEN configurado: aceita SÓ em dev; em produção RECUSA
 * (fail-closed). A rota é pública no middleware — antes, em prod sem token,
 * qualquer um podia forjar eventos de chamada.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const auth = autenticarWebhookVoopi({
    token: url.searchParams.get("token") ?? req.headers.get("x-webhook-token"),
    ref: url.searchParams.get("ref"),
    sig: url.searchParams.get("sig"),
  });
  if (!auth.ok) {
    if (auth.motivo === "sem_segredo_em_producao") {
      console.warn("[webhook voopi] VOOPI_WEBHOOK_TOKEN não configurado — requisição recusada.");
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // S13: antes esta rota chamava `db()` fora de qualquer contexto de time — todo
  // evento lançava TenantContextRequired (500) e nenhuma ligação era atualizada.
  // O core resolve a Call pelo providerCallId, abre o contexto do time como
  // sistema, não regride status, valida a URL da gravação (hosts da Voopi) e
  // agenda a transcrição.
  // Assinado (`ref` + `sig`, o callbackUrl de cada ligação): o evento só mexe
  // naquela ligação. Segredo global (webhook configurado à mão): pelo id da
  // Voopi, com o `ref` como reserva se o aviso chegar antes de gravarmos o id.
  const escopo = auth.via === "assinado" ? { soDaLigacao: auth.ref } : { ref: url.searchParams.get("ref") };
  const events = VoopiProvider.parseWebhook(body);
  for (const evt of events) {
    await applyVoopiWebhookEvent(evt, escopo);
  }

  return NextResponse.json({ ok: true, processed: events.length });
}
