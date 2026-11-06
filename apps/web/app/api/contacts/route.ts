import { z } from "zod";
import { list, contactCreateSchema, contatoParaNavegador, create, cursorPaginationSchema } from "@crmagro/core";
import { withTeam, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/contacts — lista contatos do time (paginação cursor-based).
 *   ?search=<texto>  filtra por nome/empresa/identificador
 *   ?cursor=<uuid>   id da última linha da página anterior (omitir = 1ª página)
 *   ?limit=<1..100>  tamanho da página (default 50)
 * Retorna { items, nextCursor, hasMore }.
 */
const listQuerySchema = cursorPaginationSchema.extend({
  search: z.string().trim().optional(),
});

export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(async () => {
    const { search, cursor, limit } = listQuerySchema.parse(params);
    const pagina = await list({ search, cursor, limit });
    return { ...pagina, items: pagina.items.map(contatoParaNavegador) };
  });
}

/** POST /api/contacts — cria um contato (valida com contactCreateSchema). */
export async function POST(req: Request) {
  const body = await readJson(req);
  return withTeam(async () => {
    const data = contactCreateSchema.parse(body);
    return contatoParaNavegador(await create(data));
  }, { status: 201 });
}
