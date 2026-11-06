#!/usr/bin/env node
/**
 * Limpa duplicatas ANTES dos índices únicos do item 0.8 (INT-02):
 *   1. Message com o mesmo (teamId, providerMessageId) → fica a mais antiga.
 *   2. Conversation com o mesmo (teamId, channelAccountId, contactId) → mescla
 *      na mais antiga (mensagens movidas, não-lidas somadas).
 *   3. Conversation sem contato com o mesmo (teamId, channelAccountId,
 *      externalNumber) → idem.
 *
 * Sem estas limpezas, o CREATE UNIQUE INDEX falha. Toda consulta agrupa por
 * teamId explicitamente (regra: nada de SQL em tabela de time sem teamId).
 *
 * Uso (produção, com pg_dump antes):
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- node scripts/dedup-inbound.mjs            # só conta (padrão)
 *   pnpm exec dotenv -e ../../.env -- node scripts/dedup-inbound.mjs --aplicar  # apaga/mescla
 */
import { PrismaClient } from "@prisma/client";

const aplicar = process.argv.includes("--aplicar");
const prisma = new PrismaClient();

async function mensagensDuplicadas() {
  const [{ n }] = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM (
      SELECT row_number() OVER (PARTITION BY "teamId", "providerMessageId" ORDER BY "createdAt" ASC, id ASC) AS rn
      FROM "Message" WHERE "providerMessageId" IS NOT NULL
    ) r WHERE r.rn > 1`;
  if (aplicar && n > 0) {
    await prisma.$executeRaw`
      WITH ranked AS (
        SELECT id, row_number() OVER (PARTITION BY "teamId", "providerMessageId" ORDER BY "createdAt" ASC, id ASC) AS rn
        FROM "Message" WHERE "providerMessageId" IS NOT NULL
      )
      DELETE FROM "Message" m USING ranked r WHERE m.id = r.id AND r.rn > 1`;
  }
  return n;
}

/** Pares (duplicada → mantida) por uma chave de conversa. */
async function paresDeConversa(tipo) {
  if (tipo === "contato") {
    return prisma.$queryRaw`
      SELECT id, keep_id AS "keepId", "teamId" FROM (
        SELECT id, "teamId",
          first_value(id) OVER w AS keep_id,
          row_number() OVER w AS rn
        FROM "Conversation"
        WHERE "contactId" IS NOT NULL AND "channelAccountId" IS NOT NULL
        WINDOW w AS (PARTITION BY "teamId", "channelAccountId", "contactId" ORDER BY "createdAt" ASC, id ASC)
      ) r WHERE r.rn > 1`;
  }
  return prisma.$queryRaw`
    SELECT id, keep_id AS "keepId", "teamId" FROM (
      SELECT id, "teamId",
        first_value(id) OVER w AS keep_id,
        row_number() OVER w AS rn
      FROM "Conversation"
      WHERE "contactId" IS NULL AND "channelAccountId" IS NOT NULL AND "externalNumber" IS NOT NULL
      WINDOW w AS (PARTITION BY "teamId", "channelAccountId", "externalNumber" ORDER BY "createdAt" ASC, id ASC)
    ) r WHERE r.rn > 1`;
}

async function mesclarConversas(tipo) {
  const pares = await paresDeConversa(tipo);
  if (!aplicar) return pares.length;
  for (const { id, keepId, teamId } of pares) {
    const dup = await prisma.conversation.findFirst({
      where: { id, teamId },
      select: { unreadCount: true, lastMessageAt: true },
    });
    if (!dup) continue;
    const keep = await prisma.conversation.findFirst({ where: { id: keepId, teamId }, select: { lastMessageAt: true } });
    const ultima =
      dup.lastMessageAt && (!keep?.lastMessageAt || dup.lastMessageAt > keep.lastMessageAt)
        ? dup.lastMessageAt
        : keep?.lastMessageAt ?? null;
    await prisma.$transaction([
      prisma.message.updateMany({ where: { conversationId: id, teamId }, data: { conversationId: keepId } }),
      prisma.conversation.updateMany({
        where: { id: keepId, teamId },
        data: { unreadCount: { increment: dup.unreadCount }, lastMessageAt: ultima },
      }),
      prisma.conversation.deleteMany({ where: { id, teamId } }),
    ]);
  }
  return pares.length;
}

try {
  const m = await mensagensDuplicadas();
  const c = await mesclarConversas("contato");
  const e = await mesclarConversas("numero");
  const verbo = aplicar ? "resolvidas" : "encontradas (use --aplicar para limpar)";
  console.log(`Mensagens duplicadas ${verbo}: ${m}`);
  console.log(`Conversas duplicadas (conta+contato) ${verbo}: ${c}`);
  console.log(`Conversas duplicadas (conta+número) ${verbo}: ${e}`);
} finally {
  await prisma.$disconnect();
}
