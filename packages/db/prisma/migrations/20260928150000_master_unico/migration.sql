-- Master único por time (pedido do dono, 28/09/2026): o master é UM só — quem
-- criou a empresa. `Team.masterId` aponta para ele; os demais são
-- administrador, membro ou só leitura. Coluna nula + índice único: só metadado
-- e um índice pequeno (uma linha por time).

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "masterId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Team_masterId_key" ON "Team"("masterId");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_masterId_fkey" FOREIGN KEY ("masterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill CONSERVADOR: só o time com exatamente UM "owner" ganha master (ele
-- mesmo). Time com mais de um "owner" fica sem master — não se inventa quem é;
-- o dono define pelo e-mail com `script de operação`. Idempotente.
UPDATE "Team" t SET "masterId" = o.id
FROM (
  SELECT "teamId", min(id) AS id FROM "User" WHERE role = 'owner' GROUP BY "teamId" HAVING count(*) = 1
) o
WHERE o."teamId" = t.id AND t."masterId" IS NULL;

-- Usuário criado sem papel explícito nasce com o MENOR acesso (antes: "owner",
-- herança do backfill do RBAC — foi assim que nasceram vários "owner" por
-- script/seed). Todo caminho do app grava o papel explicitamente.
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'member';
