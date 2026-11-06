import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/**
 * Escopo dos contatos (F3): os meus + os compartilhados; master/admin/"ver
 * tudo" em Contatos = todos. `{ escrita: true }`: os que a pessoa pode ALTERAR
 * ("Ver e editar de todos" em Contatos).
 */
export function escopoDoContato(uso: UsoDoEscopo = {}): Prisma.ContactWhereInput {
  return whereDoEscopo("contatos", "ownerId", { compartilhado: true, escrita: uso.escrita }) as Prisma.ContactWhereInput;
}
