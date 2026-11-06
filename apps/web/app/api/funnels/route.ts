import { listFunnels, createFunnel, funnelCreateSchema, cursorPaginationSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnels — lista funis do time (com etapas ordenadas), paginação
 * cursor-based. ?cursor=<uuid>&limit=<1..100>. Retorna { items, nextCursor, hasMore }.
 */
export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(() => {
    const { cursor, limit } = cursorPaginationSchema.parse(params);
    return listFunnels({ cursor, limit });
  });
}

/** POST /api/funnels — cria um funil (valida com funnelCreateSchema). */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    const data = funnelCreateSchema.parse(body);
    return createFunnel(data);
  }, { status: 201 });
}
