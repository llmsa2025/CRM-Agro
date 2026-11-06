#!/usr/bin/env node
/**
 * Antes do índice único "Enrollment_um_ativo" (item 0.9): se o mesmo contato
 * está 2× ATIVO no mesmo fluxo (a corrida que o índice fecha), fica a inscrição
 * mais antiga e as outras viram `failed` (visíveis na aba Histórico do fluxo —
 * nada é apagado). Agrupa por teamId explicitamente.
 *
 * Uso (produção, com pg_dump antes):
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- node scripts/dedup-enrollments.mjs            # só conta
 *   pnpm exec dotenv -e ../../.env -- node scripts/dedup-enrollments.mjs --aplicar  # marca failed
 */
import { PrismaClient } from "@prisma/client";

const aplicar = process.argv.includes("--aplicar");
const prisma = new PrismaClient();

try {
  const dups = await prisma.$queryRaw`
    SELECT id, "teamId" FROM (
      SELECT id, "teamId",
        row_number() OVER (PARTITION BY "teamId", "flowId", "contactId" ORDER BY "createdAt" ASC, id ASC) AS rn
      FROM "Enrollment" WHERE status IN ('active', 'waiting')
    ) r WHERE r.rn > 1`;
  if (aplicar) {
    for (const { id, teamId } of dups) {
      await prisma.enrollment.updateMany({ where: { id, teamId }, data: { status: "failed", nextRunAt: null } });
    }
  }
  console.log(`Inscrições ativas duplicadas ${aplicar ? "marcadas failed" : "encontradas (use --aplicar)"}: ${dups.length}`);
} finally {
  await prisma.$disconnect();
}
