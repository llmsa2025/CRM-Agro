import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/**
 * Escopo da fila de captação (F3, decisão do dono: captação é por pessoa):
 * cada um vê e decide os rascunhos que ELE capturou; master, administrador e
 * "ver tudo" em Captação veem a fila de todos. `{ escrita: true }`: os que
 * a pessoa pode importar/descartar.
 */
export function escopoRascunho(uso: UsoDoEscopo = {}): Prisma.ProspectDraftWhereInput {
  return whereDoEscopo("captacao", "ownerId", { escrita: uso.escrita }) as Prisma.ProspectDraftWhereInput;
}
