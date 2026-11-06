import { basePrisma } from "@crmagro/db";

/** Identifica a conta WhatsApp (Evolution) de um job do worker. */
export type ContaWhatsAppJob = { accountId: string; teamId: string; instance: string };

/**
 * Grava UMA chave no `ChannelAccount.meta` sem sobrescrever as outras (estado
 * do histórico, dos nomes, do IMAP…). Atualização atômica em SQL; todos os
 * identificadores do job são conferidos, inclusive o time (raw SQL em tabela
 * tenant só com `teamId` explícito — AGENTS.md §12 f).
 */
export async function gravarNoMetaDaConta(conta: ContaWhatsAppJob, chave: string, valor: unknown): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "ChannelAccount"
    SET "meta" = jsonb_set(COALESCE(NULLIF("meta", 'null'::jsonb), '{}'::jsonb), ARRAY[${chave}]::text[], ${JSON.stringify(valor)}::jsonb),
        "updatedAt" = NOW()
    WHERE "id" = ${conta.accountId} AND "teamId" = ${conta.teamId}
      AND "externalId" = ${conta.instance} AND "provider" = 'evolution'
  `;
}
