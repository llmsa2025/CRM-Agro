import { createDeal, dealCreateSchema, listFunnelDeals, listFunnelDealsInputSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/funnels/:id/deals?stageId=&status=open|won|lost&cursor=&limit= —
 * "carregar mais" do kanban (item 2.4). Devolve `{ items, nextCursor }`; o
 * `nextCursor` de cada etapa vem do `getFunnelBoard`.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id: funnelId } = await params;
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(() => listFunnelDeals(funnelId, listFunnelDealsInputSchema.parse(query)));
}

/**
 * POST /api/funnels/:id/deals — cria um deal no funil (associa um contato a
 * uma etapa). O `funnelId` vem da URL; o corpo traz stageId/contactId/valor.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id: funnelId } = await params;
  const body = await readJson(req);
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return withTeam(async () => {
    const data = dealCreateSchema.parse({ ...raw, funnelId });
    return createDeal(data);
  }, { status: 201 });
}
