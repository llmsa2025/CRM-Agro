import { filtrosDaQuery, resumoDoMapa } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/mapa/resumo — resumo da região selecionada (produto §B.3), com os
 * mesmos filtros de /api/mapa/pontos: total, por status, responderam,
 * clientes, negócios abertos (n e valor), culturas (%) e cidades.
 */
export async function GET(req: Request) {
  return withTeam(async () => resumoDoMapa(filtrosDaQuery(new URL(req.url).searchParams)));
}
