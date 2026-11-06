import { z } from "zod";

/**
 * Paginação cursor-based (Prisma cursor + take + skip 1).
 *
 * Por que cursor e não offset: `skip: N` faz o Postgres varrer e descartar N
 * linhas a cada página — custo linear no deslocamento, insustentável em listas
 * grandes. O cursor "ancora" na última linha vista (`cursor: { id }`) e o banco
 * salta direto pra ela via índice, com custo constante por página.
 *
 * Convenção de uso nos serviços:
 *   1. `orderBy` DEVE terminar com o `id` (desempate único e estável) — sem isso
 *      linhas com a mesma chave primária de ordenação (ex.: mesmo `createdAt`)
 *      podem repetir ou sumir entre páginas.
 *   2. `findMany` recebe `...applyCursor(input)` — que busca `limit + 1` linhas.
 *   3. O retorno passa por `buildResult(rows, limit)`: a linha extra vira o sinal
 *      de `hasMore` e o `id` da última linha da página vira `nextCursor`.
 *
 * Backward-compat: sem `cursor`, `applyCursor` devolve a primeira página.
 */

/** Limite máximo de itens por página (protege o banco de um `limit` absurdo). */
export const MAX_PAGE_LIMIT = 100;
/** Tamanho de página padrão quando `limit` não é informado. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Schema zod do input de paginação (valida cursor e limit nas bordas). */
export const cursorPaginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type CursorPaginationInput = z.infer<typeof cursorPaginationSchema>;

/** Página de resultados + ponteiro pra próxima (`null` quando acabou). */
export type CursorPaginationResult<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Traduz o input de paginação em argumentos de `prisma.model.findMany`.
 *
 * `take` é `limit + 1` de propósito: buscamos uma linha a mais do que a página
 * para saber se existe próxima página SEM um `count` extra. `buildResult` depois
 * descarta essa linha sentinela.
 *
 * Com `cursor`, `skip: 1` pula a própria linha-âncora (o cursor é o `id` da
 * última linha da página anterior, que já foi entregue). Sem `cursor`, começa do
 * topo (`skip: 0`).
 */
export function applyCursor(
  input: Partial<CursorPaginationInput>,
): {
  take: number;
  skip: number;
  cursor?: { id: string };
} {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  if (input.cursor) {
    return { take: limit + 1, skip: 1, cursor: { id: input.cursor } };
  }
  return { take: limit + 1, skip: 0 };
}

/**
 * Monta o resultado paginado a partir das linhas retornadas por `findMany`
 * (até `limit + 1`) e do `limit` pedido.
 *
 * Se veio a linha extra, há próxima página: descartamos a sentinela e o `id` do
 * último item da página vira `nextCursor`. Caso contrário, `nextCursor` é `null`.
 */
export function buildResult<T extends { id: string }>(
  items: T[],
  limit: number,
): CursorPaginationResult<T> {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? last.id : null,
    hasMore,
  };
}
