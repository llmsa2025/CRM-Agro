import { getFlow, updateFlow, flowUpdateSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/flows/:id — fluxo + nós (ordenados por createdAt). */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withTeam(() => getFlow(id));
}

/** PATCH /api/flows/:id — atualiza nome/trigger/status e/ou recria os nós. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(req);
  return withTeam(async () => {
    const data = flowUpdateSchema.parse(body);
    return updateFlow(id, data);
  });
}
