import { getById, update, remove, contactUpdateSchema, contatoParaNavegador } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/contacts/:id — contato + identifiers + últimas atividades. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withTeam(async () => contatoParaNavegador(await getById(id)));
}

/** PATCH /api/contacts/:id — atualiza campos do contato (partial). */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(req);
  return withTeam(async () => {
    const data = contactUpdateSchema.parse(body);
    return contatoParaNavegador(await update(id, data));
  });
}

/** DELETE /api/contacts/:id — remove o contato. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withTeam(async () => {
    await remove(id);
    return { ok: true };
  });
}
