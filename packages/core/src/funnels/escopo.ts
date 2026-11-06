import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/**
 * Escopo dos negócios (F3): o funil é do time, mas cada vendedor vê os
 * negócios DELE; master, admin e "ver tudo" em Funis veem todos e podem filtrar "por
 * vendedor" (`dono`). `{ escrita: true }`: os que a pessoa pode ALTERAR.
 */
export function escopoNegocio(dono?: string, uso: UsoDoEscopo = {}): Prisma.DealWhereInput {
  const escopo = whereDoEscopo("funis", "ownerId", { escrita: uso.escrita }) as Prisma.DealWhereInput;
  return dono ? { AND: [escopo, { ownerId: dono }] } : escopo;
}
