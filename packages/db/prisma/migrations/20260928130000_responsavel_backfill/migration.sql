-- Responsável obrigatório no contato (regra do dono, 28/09): todo contato tem
-- um responsável (`Contact.ownerId`). Os que ainda estão sem ninguém (o
-- backfill do F3 deixava sem dono o time que não tinha owner; e o que entrou
-- pelo sistema entre o F3 e esta versão nasceu NULL) ficam com o MASTER do
-- time: o owner ATIVO mais antigo; sem owner, o admin ativo mais antigo; sem
-- admin, qualquer pessoa ativa (a mais antiga). O gestor redistribui depois em
-- Contatos → selecionar → "Mudar responsável".
--
-- Tudo casa pelo teamId da própria linha — nada cruza time. Time sem nenhuma
-- pessoa ativa não é tocado. Idempotente: só mexe no que está NULL (rodar de
-- novo não muda nada). Só travas de linha (sem ALTER).
--
-- NÃO tornamos a coluna NOT NULL no banco, de propósito:
--   1) a FK `Contact.ownerId → User` é `ON DELETE SET NULL` (excluir uma pessoa
--      não pode apagar os contatos dela — o fluxo de exclusão transfere antes);
--   2) centenas de fixtures de teste criam contato sem dono direto no banco.
-- O obrigatório é garantido no app: toda criação passa por
-- `responsavelObrigatorio` (packages/core/src/contacts/responsavel.ts), que cai
-- no master quando não há pessoa.

WITH master AS (
  SELECT DISTINCT ON ("teamId") "teamId", id
  FROM "User"
  WHERE "desativadoEm" IS NULL
  ORDER BY "teamId",
           CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           "createdAt",
           id
)
UPDATE "Contact" c
SET "ownerId" = m.id
FROM master m
WHERE m."teamId" = c."teamId"
  AND c."ownerId" IS NULL;

-- Negócio sem dono: o responsável do contato (depois do passo acima). Mesma
-- junção por teamId; só o que está NULL.
UPDATE "Deal" d
SET "ownerId" = c."ownerId"
FROM "Contact" c
WHERE c.id = d."contactId"
  AND c."teamId" = d."teamId"
  AND d."ownerId" IS NULL
  AND c."ownerId" IS NOT NULL;
