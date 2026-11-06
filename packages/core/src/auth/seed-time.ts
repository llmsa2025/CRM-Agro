import type { Prisma } from "@prisma/client";
import { basePrisma } from "@crmagro/db";

/**
 * Padrões de um time recém-criado — INTERNO do auth (fora do barrel do core de
 * propósito: escreve em qualquer time sem RBAC; só o provisionamento e o
 * cadastro de empresa chamam). Auditoria do #148, S8.
 */
/** Etapas padrão do funil semeado (espelha packages/db/prisma/seed.ts). */
const DEFAULT_STAGES = [
  { nome: "Novo", cor: "#6b7280" },
  { nome: "Contatado", cor: "#3b82f6" },
  { nome: "Qualificado", cor: "#8b5cf6" },
  { nome: "Proposta", cor: "#f59e0b" },
  { nome: "Fechado", cor: "#10b981" },
];

/** Período atual no formato "YYYY-MM" usado pela meta (Goal). */
function periodoAtual(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Semeia os dados padrão de um time recém-criado: 1 funil "Vendas" com 5 etapas
 * e 1 meta do mês zerada. Usa `basePrisma` com `teamId` explícito (bootstrap) —
 * o padrão sancionado do seed. Idempotência não é necessária (time novo).
 * Aceita o cliente de uma transação (criar empresa: tudo ou nada).
 */
export async function seedNewTeam(
  teamId: string,
  ownerId: string,
  cliente: Prisma.TransactionClient | typeof basePrisma = basePrisma,
): Promise<void> {
  const funnel = await cliente.funnel.create({
    data: { teamId, nome: "Vendas", tipo: "pre_vendas" },
  });
  for (let i = 0; i < DEFAULT_STAGES.length; i++) {
    const s = DEFAULT_STAGES[i]!;
    await cliente.stage.create({
      data: { teamId, funnelId: funnel.id, nome: s.nome, ordem: i, cor: s.cor },
    });
  }
  await cliente.goal.create({
    data: { teamId, ownerId, periodo: periodoAtual(), metaValor: 0, toquesPorDia: 0 },
  });
}

