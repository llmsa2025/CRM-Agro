import { NextResponse } from "next/server";
import { z } from "zod";
import { markEmailOpened } from "@crmagro/core";

export const dynamic = "force-dynamic";

/** Os ids de mensagem são UUID: qualquer outra coisa nem chega ao banco (a rota é pública e anônima). */
const IdDeMensagem = z.string().uuid();

// GIF transparente 1x1 — o "pixel" carregado quando o e-mail é aberto.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Rota do pixel de rastreamento de ABERTURA de e-mail. Sem sessão (chamada pelo
 * cliente de e-mail do destinatário): `markEmailOpened` resolve o time cross-team.
 * Best-effort — qualquer erro é ignorado, o pixel SEMPRE responde (nunca quebra a
 * renderização do e-mail).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Id que não é UUID (lixo, sondagem): devolve o pixel sem consultar o banco.
    const mensagem = IdDeMensagem.safeParse(id);
    // O user-agent separa leitura de scanner/proxy (item 3.4): ver core/email/pixel.ts.
    if (mensagem.success) await markEmailOpened(mensagem.data, { userAgent: req.headers.get("user-agent") });
  } catch {
    /* nunca falha o pixel */
  }
  return new NextResponse(PIXEL, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "content-length": String(PIXEL.length),
    },
  });
}
