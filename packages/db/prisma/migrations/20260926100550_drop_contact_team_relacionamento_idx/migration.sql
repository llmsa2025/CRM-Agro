-- Item 2.1: substituído pelo índice (teamId, relacionamentoStatus, createdAt DESC),
-- que tem o mesmo prefixo. Só depois de o novo existir.
DROP INDEX CONCURRENTLY IF EXISTS "Contact_teamId_relacionamentoStatus_idx";
