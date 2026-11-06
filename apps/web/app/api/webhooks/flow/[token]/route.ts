import { NextResponse } from "next/server";
import { chaveDoLimiteDoWebhook, enrollByWebhook, parseWebhookLead, rateLimit } from "@crmagro/core";

/**
 * POST /api/webhooks/flow/:token
 *
 * Gatilho de WEBHOOK de um fluxo. Um sistema externo (campanha de marketing, form,
 * landing page) chama esta URL quando um lead "levanta a mão", mandando os dados
 * no corpo JSON. O `:token` (único, gerado no servidor, guardado só como hash em
 * Flow.webhookTokenHash) é o segredo que identifica QUAL fluxo. Sem token de um
 * fluxo ATIVO com gatilho Webhook, nada roda.
 *
 * Corpo aceito (aliases comuns): { nome|name, telefone|phone|whatsapp, email,
 * empresa|company, cidade, cargo, origem } — telefone OU e-mail válido é
 * obrigatório; no máximo 20 campos de até 200 caracteres (ver parseWebhookLead).
 *
 * Auditoria S5: limite por token (30/min) e por IP (60/min), e a resposta é só
 * `{ ok: true }` — nunca o id do contato.
 *
 * O token NUNCA entra em chave de limite, log ou resposta: a chave do limite usa o hash dele
 * (`chaveDoLimiteDoWebhook`), porque a chave vai para o Redis e, com o Redis fora, para o log de aviso.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POR_TOKEN = { max: 30, janelaMs: 60_000 };
const POR_IP = { max: 60, janelaMs: 60_000 };

function ipDoCliente(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

function muitas(retryAfterMs: number) {
  return NextResponse.json(
    { ok: false, error: "muitas requisições — tente de novo em instantes" },
    { status: 429, headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const ip = ipDoCliente(req);
  if (ip) {
    const rl = await rateLimit(`flowhook:ip:${ip}`, POR_IP.max, POR_IP.janelaMs);
    if (!rl.allowed) return muitas(rl.retryAfterMs);
  }
  const rlToken = await rateLimit(chaveDoLimiteDoWebhook(token), POR_TOKEN.max, POR_TOKEN.janelaMs);
  if (!rlToken.allowed) return muitas(rlToken.retryAfterMs);

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // corpo vazio/não-JSON: segue com objeto vazio (a validação abaixo barra).
  }

  const lead = parseWebhookLead(body);
  if (!lead.ok) return NextResponse.json({ ok: false, error: lead.error }, { status: 400 });

  const res = await enrollByWebhook(token, lead.data);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 404 });
  }
  // Só `{ ok: true }`: devolver o contactId entregava a quem tem o token o UUID
  // do contato EXISTENTE daquele telefone — o primeiro passo do IDOR (S1).
  return NextResponse.json({ ok: true }, { status: 200 });
}

/** GET simples de diagnóstico (checa se a rota está no ar). */
export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST { telefone|email, nome, empresa, ... } para inscrever o lead no fluxo deste token.",
  });
}
