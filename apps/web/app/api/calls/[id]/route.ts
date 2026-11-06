import { getCall, anotarCamposDaLigacao, anotarLigacaoApiSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/calls/:id — ligação + contato resumido. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withTeam(() => getCall(id));
}

/**
 * PATCH /api/calls/:id — anota a ligação. Lista de PERMISSÃO (F1A-08): o corpo só pode
 * trazer `notes` e/ou `disposition` (ao menos um). Qualquer outro campo, como `status`,
 * `durationSeconds`, `recordingUrl`, `transcript` ou `summary`, dá 400 e nada muda: esses
 * campos são do provedor. O serviço confere o escopo de escrita de Ligações (o vendedor
 * só anota a própria) e devolve 404 para a ligação de outro time ou de outro vendedor.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(req);
  return withTeam(async () => anotarCamposDaLigacao(id, anotarLigacaoApiSchema.parse(body)));
}
