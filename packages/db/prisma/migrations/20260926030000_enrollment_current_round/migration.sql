-- Item 0.9 (MF-01): round do próximo passo devido, gravado junto com o ponteiro.
-- AlterTable (coluna com default constante: sem reescrever a tabela no PG 11+)
ALTER TABLE "Enrollment" ADD COLUMN     "currentRound" INTEGER NOT NULL DEFAULT 0;
