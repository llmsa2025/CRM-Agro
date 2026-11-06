-- Item 2.7 (DP-14): FK Enrollment.flowVersionId. Apagar uma FlowVersion (junto
-- com o fluxo) confere as inscrições por este índice em vez de varrer a tabela.
-- CONCURRENTLY não trava escrita e precisa ser o ÚNICO comando do arquivo.
-- Nome igual ao que o Prisma gera para @@index([flowVersionId]).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Enrollment_flowVersionId_idx" ON "Enrollment"("flowVersionId");
