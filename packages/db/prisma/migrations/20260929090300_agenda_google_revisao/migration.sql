-- Google Agenda (fase 1, segunda revisão do #169). Tudo aditivo, menos a troca
-- do índice de (teamId, externalEventId) por um ÚNICO.
--
-- Appointment:
--   alteradoPorId        quem fez a última alteração que o convidado vê: só o
--                        próprio responsável convida pela Agenda Google dele.
--   convitesEm /
--   convitesPorConexaoId canal do convite (null na conexão = .ics): quem já foi
--                        convidado não recebe um segundo convite por outro caminho.
-- AppointmentLink:
--   camposHash           impressão digital dos campos comuns (RSVP e Meet não
--                        atropelam uma mudança do CRM Agro ainda não enviada).
--   canceladoNoGoogleEm  o cancelamento veio do Google (só esse é desfeito de lá).
--   UNIQUE (teamId, externalEventId): um compromisso por evento no time.
-- CalendarSync:
--   canalTentarEm        espera depois de falha no `watch`.
--   janelaAte            até onde a última sincronização completa enxergou.
-- CalendarBusyBlock:
--   naoImportar          "Tirar do CRM Agro": fica só "Ocupado", sem importar de novo.

-- DropIndex
DROP INDEX "AppointmentLink_teamId_externalEventId_idx";

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "alteradoPorId" TEXT,
ADD COLUMN     "convitesEm" TIMESTAMP(3),
ADD COLUMN     "convitesPorConexaoId" TEXT;

-- AlterTable
ALTER TABLE "CalendarSync" ADD COLUMN     "canalTentarEm" TIMESTAMP(3),
ADD COLUMN     "janelaAte" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AppointmentLink" ADD COLUMN     "camposHash" TEXT,
ADD COLUMN     "canceladoNoGoogleEm" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CalendarBusyBlock" ADD COLUMN     "naoImportar" BOOLEAN NOT NULL DEFAULT false;

-- Vínculo em dobro para o mesmo evento no time (só poderia existir antes desta
-- revisão, e só em ambiente de teste — a tabela ainda não foi para a produção):
-- fica o mais antigo, para o índice único entrar.
DELETE FROM "AppointmentLink" l
USING "AppointmentLink" o
WHERE l."teamId" = o."teamId"
  AND l."externalEventId" = o."externalEventId"
  AND (l."createdAt", l."id") > (o."createdAt", o."id");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentLink_teamId_externalEventId_key" ON "AppointmentLink"("teamId", "externalEventId");

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- Compromisso que já tem convidados já os convidou: pelo evento do Google, se
-- há vínculo que chegou lá (o do organizador), senão pelo .ics de sempre
-- (inclui os convidados copiados de `convidadoEmail`). Assim, quem conectar a
-- agenda depois não manda um segundo convite a eles.
UPDATE "Appointment" a
SET "convitesEm" = a."createdAt",
    "convitesPorConexaoId" = (
      SELECT l."connectionId"
      FROM "AppointmentLink" l
      WHERE l."appointmentId" = a."id" AND l."sincronizadoEm" IS NOT NULL AND l."origem" <> 'convite'
      ORDER BY l."createdAt"
      LIMIT 1
    )
WHERE a."convitesEm" IS NULL
  AND EXISTS (SELECT 1 FROM "AppointmentAttendee" at WHERE at."appointmentId" = a."id");
