-- Item 1.4 (MF-08): profundidade de gatilho para cortar cascatas entre fluxos (default constante: sem reescrever a tabela).
-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "profundidade" INTEGER NOT NULL DEFAULT 0;

