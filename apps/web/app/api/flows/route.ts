import { listFlows, createFlow, flowCreateSchema, cursorPaginationSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/flows — lista fluxos do time (com contagem de inscrições), paginação
 * cursor-based. ?cursor=<uuid>&limit=<1..100>. Retorna { items, nextCursor, hasMore }.
 */
export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(() => {
    const { cursor, limit } = cursorPaginationSchema.parse(params);
    return listFlows({ cursor, limit });
  });
}

/** POST /api/flows — cria um fluxo (rascunho) com seus nós; valida com zod. */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    const data = flowCreateSchema.parse(body);
    return createFlow(data);
  }, { status: 201 });
}
