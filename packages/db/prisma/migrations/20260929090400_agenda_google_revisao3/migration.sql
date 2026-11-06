-- Google Agenda (fase 1, terceira revisão do #169). Tudo aditivo.
--
-- Appointment:
--   convitesICalUID      iCalUID do evento do Google que convidou: o .ics que
--                        sai depois que aquele Google saiu de cena usa o MESMO
--                        UID (o cliente de e-mail não fica com o evento em dobro).
--   camposHashNoGoogle   impressão digital dos campos comuns na última vez que
--                        CRM Agro e Google ficaram iguais (sobrevive à perda do
--                        vínculo: ao religar, diz quem mudou no meio).
--   privadoAteConfirmar  veio da Agenda Google e a dona não confirmou que é de
--                        trabalho: só ela vê.
-- AppointmentLink:
--   cancelarEm /
--   cancelarAvisando     vínculo aposentado na troca de responsável: o evento do
--                        antigo organizador é cancelado lá (durável, pelo worker).

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "camposHashNoGoogle" TEXT,
ADD COLUMN     "convitesICalUID" TEXT,
ADD COLUMN     "privadoAteConfirmar" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AppointmentLink" ADD COLUMN     "cancelarAvisando" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelarEm" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Backfill (a integração ainda não foi para a produção: só o banco de teste
-- tem linhas aqui)
-- ---------------------------------------------------------------------------

-- O convite saiu por um evento do Google que ainda está ligado: guarda o UID dele.
UPDATE "Appointment" a
SET "convitesICalUID" = l."iCalUID"
FROM "AppointmentLink" l
WHERE l."appointmentId" = a."id"
  AND l."connectionId" = a."convitesPorConexaoId"
  AND l."iCalUID" IS NOT NULL
  AND a."convitesICalUID" IS NULL;

-- Base da comparação ao religar: o retrato do vínculo que existe hoje.
UPDATE "Appointment" a
SET "camposHashNoGoogle" = l."camposHash"
FROM "AppointmentLink" l
WHERE l."appointmentId" = a."id"
  AND l."camposHash" IS NOT NULL
  AND a."camposHashNoGoogle" IS NULL;

-- O que já veio da Agenda Google fica só com a dona até ela confirmar.
UPDATE "Appointment" SET "privadoAteConfirmar" = true WHERE "origem" = 'google';
