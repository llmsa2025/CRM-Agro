import type { Prisma } from "@prisma/client";
import { whereDoEscopo, type UsoDoEscopo } from "../tenancy/escopo";

/**
 * Escopo dos fluxos (F3): os de quem criou + os compartilhados; master, admin
 * e "ver tudo" em Fluxos veem todos. Só a TELA e as ações de pessoa: o motor e os
 * gatilhos rodam como sistema e disparam todos os fluxos ativos do time.
 * `{ escrita: true }`: os que a pessoa pode alterar (editar, ativar, pausar,
 * inscrever).
 */
export function escopoFluxo(uso: UsoDoEscopo = {}): Prisma.FlowWhereInput {
  return whereDoEscopo("fluxos", "createdById", { compartilhado: true, escrita: uso.escrita }) as Prisma.FlowWhereInput;
}

/** Inscrição no escopo: a de um fluxo que a pessoa vê (ou, com `escrita`, altera). */
export function escopoInscricao(uso: UsoDoEscopo = {}): Prisma.EnrollmentWhereInput {
  const f = escopoFluxo(uso);
  return Object.keys(f).length ? { flow: f } : {};
}
