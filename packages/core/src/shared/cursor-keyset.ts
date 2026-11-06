import { z } from "zod";

/**
 * Cursor por VALOR para paginação "keyset" em `(data, id)` (item 2.2).
 *
 * Diferente do `pagination.ts` (cursor = id da linha, o Prisma relê a linha
 * âncora): aqui o cursor carrega os VALORES da última linha entregue. Se ela
 * mudar de lugar (conversa que recebeu mensagem e subiu para o topo) ou for
 * apagada, a próxima página continua exatamente de onde parou — sem repetir nem
 * pular. O desempate por `id` garante a ordem estável com a data empatada.
 *
 * Opaco para o cliente (base64url de `[iso|null, id]`); o servidor valida.
 */
export class CursorInvalido extends Error {
  constructor() {
    super("CursorInvalido");
    this.name = "CursorInvalido";
  }
}

export type ChaveCursor = { em: Date | null; id: string };

const cursorSchema = z.tuple([z.string().datetime().nullable(), z.string().min(1).max(64)]);

export function codificarCursor(c: ChaveCursor): string {
  return Buffer.from(JSON.stringify([c.em ? c.em.toISOString() : null, c.id])).toString("base64url");
}

export function decodificarCursor(cursor: string): ChaveCursor {
  try {
    const [em, id] = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { em: em ? new Date(em) : null, id };
  } catch {
    throw new CursorInvalido();
  }
}
