import { filtrosDaQuery, pontosDoMapa } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/mapa/pontos — pontos do mapa do time (produto §B.3).
 *   ?bbox=w,s,e,n&status=novo,cliente&interesse=&tag=&produtor=&cultura=&campanha=&dias=&negocio=aberto|sem
 * Até 5.000: arrays compactos { ids, lat, lng, st, nome, empresa, cidade };
 * acima: { tipo: "clusters", clusters: [{ lat, lng, n, porStatus }] }.
 * Filtro inválido → 400 (zod).
 */
export async function GET(req: Request) {
  return withTeam(async () => pontosDoMapa(filtrosDaQuery(new URL(req.url).searchParams)));
}
