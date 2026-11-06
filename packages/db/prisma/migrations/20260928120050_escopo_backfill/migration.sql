-- Backfill do escopo por dono (plano-equipe-permissoes F3): o que já existe
-- fica com o MASTER de cada time (o owner mais antigo); o administrador
-- redistribui depois ("Transferir dono"). Tudo casa pelo teamId da própria
-- linha — nada cruza time. Time sem owner fica sem dono (só master/admin veem)
-- e as linhas dele nem são reescritas. Idempotente: só toca o que está NULL.
-- Em transação própria (separado dos ALTER): aqui só há travas de linha.

WITH master AS (
  SELECT DISTINCT ON ("teamId") "teamId", id FROM "User" WHERE role = 'owner' ORDER BY "teamId", "createdAt"
)
UPDATE "Contact" c SET "ownerId" = m.id FROM master m WHERE m."teamId" = c."teamId" AND c."ownerId" IS NULL;

-- Negócio: o dono do contato (depois do backfill acima).
UPDATE "Deal" d SET "ownerId" = c."ownerId"
FROM "Contact" c
WHERE c.id = d."contactId" AND c."teamId" = d."teamId" AND d."ownerId" IS NULL AND c."ownerId" IS NOT NULL;

WITH master AS (
  SELECT DISTINCT ON ("teamId") "teamId", id FROM "User" WHERE role = 'owner' ORDER BY "teamId", "createdAt"
)
UPDATE "ChannelAccount" a SET "ownerId" = m.id FROM master m WHERE m."teamId" = a."teamId" AND a."ownerId" IS NULL;

-- Fluxos que já existiam são do time: nascem compartilhados.
WITH master AS (
  SELECT DISTINCT ON ("teamId") "teamId", id FROM "User" WHERE role = 'owner' ORDER BY "teamId", "createdAt"
)
UPDATE "Flow" f SET "createdById" = m.id, "compartilhado" = true FROM master m WHERE m."teamId" = f."teamId" AND f."createdById" IS NULL;

WITH master AS (
  SELECT DISTINCT ON ("teamId") "teamId", id FROM "User" WHERE role = 'owner' ORDER BY "teamId", "createdAt"
)
UPDATE "ProspectDraft" p SET "ownerId" = m.id FROM master m WHERE m."teamId" = p."teamId" AND p."ownerId" IS NULL;

WITH master AS (
  SELECT DISTINCT ON ("teamId") "teamId", id FROM "User" WHERE role = 'owner' ORDER BY "teamId", "createdAt"
)
UPDATE "Campaign" k SET "createdById" = m.id FROM master m WHERE m."teamId" = k."teamId" AND k."createdById" IS NULL;
