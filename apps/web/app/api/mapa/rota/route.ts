import { rotaDoDia, rotaSchema } from "@crmagro/core";
import { readJson, withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/mapa/rota — rota do dia (produto §B.3).
 *   corpo: { data?: "YYYY-MM-DD", origem?: { lat, lng } }  (origem = posição do navegador)
 * Compromissos pendentes do dia com contato localizado, em ordem de vizinho
 * mais próximo, + link do Google Maps. Corpo inválido → 400 (zod).
 */
export async function POST(req: Request) {
  const corpo = await readJson(req);
  return withTeam(async () => rotaDoDia(rotaSchema.parse(corpo)));
}
