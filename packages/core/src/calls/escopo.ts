import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/** Escopo das ligações (F3): as de quem ligou; master/admin/"ver tudo" em Ligações veem todas. `{ escrita: true }`: as que altera. */
export function escopoLigacao(uso: UsoDoEscopo = {}): Prisma.CallWhereInput {
  return whereDoEscopo("ligacoes", "userId", { escrita: uso.escrita }) as Prisma.CallWhereInput;
}
