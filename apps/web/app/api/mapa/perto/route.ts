import { contatosPerto } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/mapa/perto?contactId=<uuid>&km=15 — os 10 contatos do time mais
 * próximos do contato, num raio de `km` (padrão 15, máx. 500). Contato de
 * outro time → 404.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return withTeam(async () => contatosPerto({ contactId: p.get("contactId") ?? "", km: p.get("km") ? Number(p.get("km")) : undefined }));
}
