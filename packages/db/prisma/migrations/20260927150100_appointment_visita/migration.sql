-- Agenda (produto §E): visita com local, lembrete por Web Push e responsável.
--
-- `lembreteMin` nasce 30 para as linhas existentes também (ADD COLUMN com
-- DEFAULT constante preenche sem reescrever a tabela): os compromissos
-- pendentes passam a ter lembrete 30 min antes.
-- O valor novo do enum não é usado neste arquivo (Postgres não deixa usar na
-- mesma transação em que foi criado).

-- AlterEnum
ALTER TYPE "AppointmentType" ADD VALUE 'visita';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "lembreteEnviadoEm" TIMESTAMP(3),
ADD COLUMN     "lembreteMin" INTEGER DEFAULT 30,
ADD COLUMN     "local" TEXT,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "responsavelId" TEXT;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_responsavelId_fkey" FOREIGN KEY ("responsavelId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill do responsável. O compromisso não guardava quem criou: fica com o
-- dono (owner) mais antigo DO PRÓPRIO TIME da linha (ou o usuário mais antigo,
-- se o time não tiver owner). Na validação cada time tem 1 usuário, que é quem
-- criou. A subconsulta leva o teamId da linha: nada cruza time.
UPDATE "Appointment" a
SET "responsavelId" = (
  SELECT u."id" FROM "User" u
  WHERE u."teamId" = a."teamId"
  ORDER BY (u."role" = 'owner') DESC, u."createdAt" ASC, u."id" ASC
  LIMIT 1
)
WHERE a."responsavelId" IS NULL;
