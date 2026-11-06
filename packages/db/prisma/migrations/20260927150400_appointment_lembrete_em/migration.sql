-- Agenda (produto §E): hora do lembrete calculada no banco.
--
-- `lembreteEm` = inicio − lembreteMin minutos (null sem lembrete). Um TRIGGER
-- mantém o valor em todo INSERT e em todo UPDATE de "inicio"/"lembreteMin",
-- por qualquer caminho (Agenda, compromisso criado pela IA da campanha, SQL
-- direto). Assim o job agenda-lembrete (cruza times, a cada 1 min) pede ao
-- banco só os lembretes vencidos, em vez de trazer as próximas 24 h de todos
-- os times. O mesmo trigger zera `lembreteEnviadoEm` quando o horário ou a
-- antecedência mudam: compromisso remarcado ganha lembrete novo.
-- O Prisma não modela trigger: não gera drift nos próximos `migrate diff`.

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "lembreteEm" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION crmagro_appointment_lembrete() RETURNS trigger AS $$
BEGIN
  NEW."lembreteEm" := CASE
    WHEN NEW."lembreteMin" IS NULL THEN NULL
    ELSE NEW."inicio" - make_interval(mins => NEW."lembreteMin")
  END;
  IF TG_OP = 'UPDATE'
     AND (OLD."inicio" IS DISTINCT FROM NEW."inicio" OR OLD."lembreteMin" IS DISTINCT FROM NEW."lembreteMin") THEN
    NEW."lembreteEnviadoEm" := NULL;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Appointment_lembrete" ON "Appointment";
CREATE TRIGGER "Appointment_lembrete"
  BEFORE INSERT OR UPDATE OF "inicio", "lembreteMin" ON "Appointment"
  FOR EACH ROW
  EXECUTE FUNCTION crmagro_appointment_lembrete();

-- Linhas existentes (o UPDATE direto de "lembreteEm" não dispara o trigger).
UPDATE "Appointment"
SET "lembreteEm" = "inicio" - make_interval(mins => "lembreteMin")
WHERE "lembreteMin" IS NOT NULL;
