import { chavePublicaPush } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/push/chave-publica — chave VAPID pública para o
 * `PushManager.subscribe` do navegador. `{ chave: null }` = push desligado no
 * servidor (a tela esconde o botão de ativar avisos).
 */
export async function GET() {
  return withTeam(async () => chavePublicaPush());
}
