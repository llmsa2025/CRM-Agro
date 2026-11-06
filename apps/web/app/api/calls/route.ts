import { listCalls, callStatusSchema, cursorPaginationSchema } from "@crmagro/core";
import { z } from "zod";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/calls — lista ligações do time (paginação cursor-based).
 *   ?status=<CallStatus>   filtra por status
 *   ?contactId=<uuid>      filtra por contato
 *   ?from / ?to            período (ISO) sobre createdAt
 *   ?cursor=<uuid>         id da última linha da página anterior (omitir = 1ª)
 *   ?limit=<1..100>        tamanho da página (default 50)
 * Retorna { items, nextCursor, hasMore }.
 *
 * Esta rota só LÊ. Não existe POST: a ligação nasce do discador e do provedor,
 * nunca de um corpo vindo do cliente (F1A-08; o Next responde 405 ao POST).
 */
const listQuerySchema = cursorPaginationSchema.extend({
  status: callStatusSchema.optional(),
  contactId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return withTeam(async () => {
    const { status, contactId, from, to, cursor, limit } = listQuerySchema.parse(params);
    return listCalls({ status, contactId, from, to, cursor, limit });
  });
}
