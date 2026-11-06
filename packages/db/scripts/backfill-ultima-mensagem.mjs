#!/usr/bin/env node
/**
 * Preenche o resumo da última mensagem nas conversas ANTIGAS (item 2.2, DP-01):
 * `lastMessagePreview`, `lastMessageDirecao` e `lastMessageSubject` da
 * Conversation (migration 20260926110000_conversation_last_message).
 *
 * As conversas novas já nascem preenchidas (`touchConversation` grava junto do
 * `lastMessageAt`); sem este backfill, as antigas aparecem na lista do inbox sem
 * prévia até a próxima mensagem.
 *
 * - Por time e em lotes de 500 conversas (cursor por id).
 * - Só mexe em conversa ainda sem prévia (`lastMessageDirecao IS NULL`): se uma
 *   mensagem nova chegar durante o backfill, a gravação dela vence.
 * - Toda consulta filtra `teamId` explicitamente (regra: nada de SQL em tabela
 *   de time sem teamId).
 *
 * Uso (produção; depois da migration e do deploy):
 *   cd /srv/crmagro/packages/db
 *   pnpm exec dotenv -e ../../.env -- node scripts/backfill-ultima-mensagem.mjs                  # só conta (padrão)
 *   pnpm exec dotenv -e ../../.env -- node scripts/backfill-ultima-mensagem.mjs --aplicar        # grava
 *   pnpm exec dotenv -e ../../.env -- node scripts/backfill-ultima-mensagem.mjs --time=<uuid>    # um time só
 */
import { PrismaClient } from "@prisma/client";

const aplicar = process.argv.includes("--aplicar");
const soTime = process.argv.find((a) => a.startsWith("--time="))?.slice("--time=".length) || null;
const LOTE = 500;
const prisma = new PrismaClient();

/** Conversas do time que têm mensagem e ainda não têm prévia. */
async function pendentes(teamId) {
  return prisma.conversation.count({
    where: { teamId, lastMessageDirecao: null, messages: { some: { teamId } } },
  });
}

/**
 * Preenche um lote: a última mensagem de cada conversa (DISTINCT ON), com a
 * mesma regra da prévia do código (`previewDaMensagem`): texto sem espaços nas
 * pontas cortado em 200, ou "[image]"/"[audio]"/"[doc]" para mídia sem legenda.
 */
async function preencherLote(teamId, ids) {
  return prisma.$executeRaw`
    UPDATE "Conversation" c SET
      "lastMessagePreview" = m.preview,
      "lastMessageDirecao" = m.direcao,
      "lastMessageSubject" = m.subject
    FROM (
      SELECT DISTINCT ON ("conversationId")
        "conversationId",
        CASE
          WHEN btrim(coalesce(conteudo, ''), E' \\t\\r\\n') <> '' THEN
            CASE
              WHEN char_length(btrim(conteudo, E' \\t\\r\\n')) > 200 THEN left(btrim(conteudo, E' \\t\\r\\n'), 199) || '…'
              ELSE btrim(conteudo, E' \\t\\r\\n')
            END
          WHEN tipo::text <> 'text' THEN '[' || tipo::text || ']'
          ELSE ''
        END AS preview,
        direcao,
        meta->>'subject' AS subject
      FROM "Message"
      WHERE "teamId" = ${teamId} AND "conversationId" = ANY(${ids}::text[])
      ORDER BY "conversationId", "createdAt" DESC, id DESC
    ) m
    WHERE c.id = m."conversationId" AND c."teamId" = ${teamId} AND c."lastMessageDirecao" IS NULL`;
}

async function preencherTime(teamId) {
  let depois = "";
  let total = 0;
  for (;;) {
    const lote = await prisma.conversation.findMany({
      where: { teamId, lastMessageDirecao: null, id: { gt: depois } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: LOTE,
    });
    if (lote.length === 0) break;
    depois = lote[lote.length - 1].id;
    total += await preencherLote(
      teamId,
      lote.map((c) => c.id),
    );
  }
  return total;
}

try {
  const times = await prisma.team.findMany({
    where: soTime ? { id: soTime } : {},
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  let soma = 0;
  for (const t of times) {
    const n = aplicar ? await preencherTime(t.id) : await pendentes(t.id);
    if (n > 0) console.log(`  ${t.id} (${t.name}): ${n}`);
    soma += n;
  }
  const verbo = aplicar ? "preenchidas" : "sem prévia (use --aplicar para preencher)";
  console.log(`Conversas ${verbo}: ${soma} em ${times.length} time(s)`);
} finally {
  await prisma.$disconnect();
}
