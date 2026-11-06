import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/** Escopo das campanhas (F3): as de quem criou + as compartilhadas; master/admin/"ver tudo" em Campanhas veem todas. `{ escrita: true }`: as que altera. */
export function escopoCampanha(uso: UsoDoEscopo = {}): Prisma.CampaignWhereInput {
  return whereDoEscopo("campanhas", "createdById", { compartilhado: true, escrita: uso.escrita }) as Prisma.CampaignWhereInput;
}
