-- Item 1.1 (MF-02): espera por resposta orientada a evento (colunas nulas: sem reescrever a tabela).
-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "waitingFor" TEXT,
ADD COLUMN     "waitingUntil" TIMESTAMP(3);

