import { listGoals, createGoal, createGoalSchema, cursorPaginationSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/configuracoes/metas — lista as metas do time (período desc),
 * paginação cursor-based. ?cursor=<uuid>&limit=<1..100>.
 * Retorna { items, nextCursor, hasMore }.
 */
export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(() => {
    const { cursor, limit } = cursorPaginationSchema.parse(params);
    return listGoals({ cursor, limit });
  });
}

/** POST /api/configuracoes/metas — cria uma meta (valida com createGoalSchema). */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    const data = createGoalSchema.parse(body);
    return createGoal(data);
  }, { status: 201 });
}
