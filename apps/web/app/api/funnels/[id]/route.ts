import { getFunnel, updateFunnel, funnelUpdateSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/funnels/:id — funil + etapas + TODOS os deals (contato só com id,
 * nome e empresa). Formato legado; o kanban paginado é `getFunnelBoard` +
 * GET /api/funnels/:id/deals (item 2.4).
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withTeam(() => getFunnel(id));
}

/** PATCH /api/funnels/:id — atualiza campos do funil (partial). */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(req);
  return withTeam(async () => {
    const data = funnelUpdateSchema.parse(body);
    return updateFunnel(id, data);
  });
}
