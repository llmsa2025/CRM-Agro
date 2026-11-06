-- Agenda Google: o bloco "Ocupado" guarda o título do evento para a DONA da agenda ver (colegas e gestor
-- continuam vendo só "Ocupado"). Colunas novas, sem política nova de RLS (a tabela já tem).
ALTER TABLE "CalendarBusyBlock" ADD COLUMN "titulo" TEXT;

-- Os blocos que já existem não têm título e o cursor incremental não reenvia evento parado:
-- zera o cursor para a próxima rodada ser completa e preencher os títulos.
UPDATE "CalendarSync" SET "syncToken" = NULL;
