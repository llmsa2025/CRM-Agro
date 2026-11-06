import { lerCorpoComLimite } from "@crmagro/channels";
import { aceitarEmailEncaminhado, LIMITE_ENTRADA_BYTES, logger } from "@crmagro/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Entrada de e-mail por encaminhamento (Gmail → Cloudflare → CRM Agro). O Email Worker
 * do Cloudflare (`deploy/cloudflare/email-entrada/`) faz POST aqui com o e-mail cru
 * e uma assinatura HMAC. A rota só lê o corpo (com teto), repassa para
 * `aceitarEmailEncaminhado` (assinatura, endereço, limite, banco e fila) e devolve a
 * resposta do contrato: 200, 401, 404, 413, 429 ou 503.
 *
 * O MIME NÃO é lido aqui: isso é do worker. Nenhum log de corpo, remetente nem destinatário.
 * `/api/webhooks` já é público no middleware: a autenticação é a assinatura.
 */
export async function POST(req: Request) {
  try {
    const corpo = await lerCorpoComLimite(req, LIMITE_ENTRADA_BYTES);
    const r = await aceitarEmailEncaminhado({ cabecalhos: req.headers, corpo });
    return Response.json(r.body, { status: r.status });
  } catch (err) {
    // Falha passageira: 503 (o Cloudflare guarda o e-mail e tenta de novo). Nunca 404.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[email-entrada] falha ao aceitar o pedido");
    return Response.json({ ok: false }, { status: 503 });
  }
}

export function GET() {
  return Response.json({ ok: true, service: "crmagro/email-entrada" });
}
