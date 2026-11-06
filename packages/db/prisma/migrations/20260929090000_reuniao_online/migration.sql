-- Google Agenda (fase 1, 28/09) — decisão 9: "reunião online" é um tipo de
-- compromisso; o Google Meet nasce junto com o evento no Google.
-- Arquivo só com o valor novo: o Postgres não deixa usar o valor na mesma
-- transação em que foi criado (mesmo padrão da migration da visita).

-- AlterEnum
ALTER TYPE "AppointmentType" ADD VALUE 'reuniao_online';
