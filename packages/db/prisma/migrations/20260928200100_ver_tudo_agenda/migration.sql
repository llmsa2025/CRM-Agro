-- "Ver tudo" por tela, tela Agenda: a auditoria de isolamento (#157) deu
-- escopo por pessoa à Agenda (`escopoCompromisso`), que passou a ser uma das
-- telas com dono (MODULOS_COM_DONO). Quem tinha o "ver tudo" antigo
-- (`verTudo = true`, convertido para todas as telas em
-- 20260928150100_ver_tudo_por_tela) continua vendo a Agenda de todos.
-- Idempotente: só acrescenta onde ainda não está. Só travas de linha.

UPDATE "User"
SET "verTudoEm" = array_append(coalesce("verTudoEm", ARRAY[]::TEXT[]), 'agenda')
WHERE "verTudo" = true AND NOT ('agenda' = ANY (coalesce("verTudoEm", ARRAY[]::TEXT[])));

UPDATE "Invite"
SET "verTudoEm" = array_append(coalesce("verTudoEm", ARRAY[]::TEXT[]), 'agenda')
WHERE "verTudo" = true AND NOT ('agenda' = ANY (coalesce("verTudoEm", ARRAY[]::TEXT[])));
