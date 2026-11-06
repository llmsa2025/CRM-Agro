import { removerAssinaturaPush, salvarAssinaturaPush } from "@crmagro/core";
import { readJson, withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Assinatura de Web Push do navegador do usuário logado. O time e o usuário
 * vêm da SESSÃO, nunca do corpo.
 *
 * POST   corpo: `PushSubscription.toJSON()` ({ endpoint, keys: { p256dh, auth } })
 *        → grava (o mesmo navegador assinado por outra pessoa passa a ser deste usuário).
 * DELETE corpo: { endpoint } → remove a assinatura deste navegador.
 * Corpo inválido ou endpoint fora dos serviços de push conhecidos → 400 (zod).
 */
export async function POST(req: Request) {
  const corpo = await readJson(req);
  const userAgent = req.headers.get("user-agent");
  return withTeam(async () => salvarAssinaturaPush(corpo, userAgent), { status: 201 });
}

export async function DELETE(req: Request) {
  const corpo = await readJson(req);
  return withTeam(async () => removerAssinaturaPush(corpo));
}
