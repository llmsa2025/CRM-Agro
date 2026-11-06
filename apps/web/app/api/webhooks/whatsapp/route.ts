import { env } from "@crmagro/config";
import { acceptWhatsAppWebhook, autenticarWebhookWhatsApp, logger, WEBHOOK_TOKEN_HEADER } from "@crmagro/core";

/**
 * Autentica a origem do webhook (item 3.7, S18): token DA INSTÂNCIA no header
 * `x-webhook-token`, conferido contra a `instance` do próprio payload. Durante
 * a transição, o segredo global em `?token=` (como a Evolution de produção
 * ainda manda) é aceito até `WHATSAPP_WEBHOOK_LEGADO=off`. Produção sem
 * WHATSAPP_WEBHOOK_TOKEN → fail-closed. Detalhes em
 * `packages/core/src/integrations/whatsapp-webhook-token.ts`.
 */
function instanciaDoCorpo(body: unknown): string | null {
  const i = (body as { instance?: unknown } | null)?.instance;
  return typeof i === "string" && i ? i : null;
}

// Aviso do formato antigo: no máximo 1 a cada 10 min por processo.
let ultimoAvisoLegado = 0;

/**
 * Webhook de entrada da Evolution API (messages.upsert e messages.update).
 *
 * Item 0.8 (auditoria INT-01): a rota só AUTENTICA e GRAVA NA FILA `inbound`
 * (Redis, milissegundos) — o worker processa com retry. Antes respondia 200 e
 * processava em `after()` aqui no web: qualquer falha (banco, deploy, restart)
 * perdia a mensagem em silêncio, porque a Evolution já tinha recebido o 200.
 * Agora, se nem a fila aceitar (Redis fora), a resposta é 503 e a Evolution
 * REENVIA. Mensagens `fromMe` também vão para a fila (histórico completo).
 */
export async function POST(req: Request) {
  const header = req.headers.get(WEBHOOK_TOKEN_HEADER);
  const query = new URL(req.url).searchParams.get("token");
  // Sem token nenhum: recusa antes de ler o corpo.
  if (env.WHATSAPP_WEBHOOK_TOKEN && !header && !query) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const auth = autenticarWebhookWhatsApp({
    instance: instanciaDoCorpo(body),
    header,
    query,
  });
  if (!auth.ok) {
    if (auth.motivo === "sem_segredo_em_producao") {
      logger.error("[webhook whatsapp] WHATSAPP_WEBHOOK_TOKEN não configurado em produção — REJEITANDO");
    }
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (auth.via === "legado" && Date.now() - ultimoAvisoLegado > 10 * 60_000) {
    ultimoAvisoLegado = Date.now();
    logger.warn(
      { instance: instanciaDoCorpo(body) },
      "[webhook whatsapp] token global (formato antigo) — reaplique o webhook com o token da instância",
    );
  }

  const r = await acceptWhatsAppWebhook(body);
  return Response.json(r.body, { status: r.status });
}

export function GET() {
  return Response.json({ ok: true, service: "crmagro/whatsapp-webhook" });
}
