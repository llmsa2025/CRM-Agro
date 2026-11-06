-- F1B-05: confere a FK Call.linhaId, criada com NOT VALID na migration anterior.
-- Todas as ligações existentes têm linhaId nulo, então a conferência passa; o lock_timeout evita ficar
-- na fila de travas se Call estiver ocupada (VALIDATE CONSTRAINT só pede uma trava que deixa ler e escrever).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE "Call" VALIDATE CONSTRAINT "Call_linhaId_fkey";
