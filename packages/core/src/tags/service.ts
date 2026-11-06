import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { safeEnrollByTrigger, safeEnrollManyByTrigger } from "../flows/triggers";
import { TagNotFound, TagJaExiste } from "./errors";
import { assertOwned, assertOwnedMany } from "../tenancy/assert-owned";
import type { TagCreate, TagUpdate } from "./schema";
import { requireCan } from "../auth/authz";
import { chaveDaTag } from "./por-nome";

import { escopoDoContato } from "../contacts/escopo";
/**
 * Serviços de tag. Puros: dependem só de @crmagro/db (ver contacts/service.ts).
 *
 * O contato pode ter várias tags. O menu da linha e a ação em massa da tela de
 * Contatos ADICIONAM e TIRAM uma tag (`addContactTag`, `removeContactTag`,
 * `addTagBulk`, `removeTagBulk`) sem mexer nas outras. `setContactTag` e
 * `assignTagBulk` são a regra antiga de uma tag por contato (trocam tudo pela
 * tag dada); a tela só os usa com `null`, para "Remover todas as tags".
 */

/** Tag com a contagem de contatos vinculados (para os chips do cabeçalho). */
export type TagWithCount = {
  id: string;
  nome: string;
  cor: string | null;
  count: number;
};

/**
 * Lista as tags do time com a contagem de contatos de cada uma (nome asc).
 *
 * A contagem vem de um `groupBy` em ContactTag, que passa pela extensão de
 * tenancy (`WHERE "teamId" = $1 GROUP BY "tagId"`). O `include: { _count }`
 * de antes virava `LEFT JOIN (SELECT "tagId", COUNT(*) FROM "ContactTag" WHERE
 * 1=1 GROUP BY "tagId")`: agregava a tabela de TODOS os times (DP-11).
 */
export async function listTags(): Promise<TagWithCount[]> {
  const prisma = db();
  const [rows, contagens] = await Promise.all([
    prisma.tag.findMany({ orderBy: { nome: "asc" }, select: { id: true, nome: true, cor: true } }),
    // F3: contagem só dos contatos do escopo (bate com o total da barra).
    prisma.contactTag.groupBy({ by: ["tagId"], where: { contact: escopoDoContato() }, _count: { _all: true } }),
  ]);
  const porTag = new Map(contagens.map((g) => [g.tagId, g._count._all]));
  return rows.map((t) => ({ id: t.id, nome: t.nome, cor: t.cor, count: porTag.get(t.id) ?? 0 }));
}

/**
 * Resumo para a barra de filtro de Contatos: total de contatos, quantos estão
 * "sem tag", e a contagem por tag.
 *
 * `semTag` é contado no banco (`NOT EXISTS` em ContactTag por contato — usa o
 * índice de `contactId`). Antes carregava TODAS as linhas de ContactTag do time
 * para subtrair do total na memória (DP-10).
 */
export async function tagFilterSummary(): Promise<{
  total: number;
  semTag: number;
  tags: TagWithCount[];
}> {
  const prisma = db();
  const [total, semTag, tags] = await Promise.all([
    // F3: contagens do escopo de quem pede.
    prisma.contact.count({ where: escopoDoContato() }),
    prisma.contact.count({ where: { AND: [{ contactTags: { none: {} } }, escopoDoContato()] } }),
    listTags(),
  ]);
  return { total, semTag, tags };
}

/** Cria uma tag. Conflito de nome único (P2002) → TagJaExiste. */
export async function createTag(data: TagCreate) {
  requireCan("tags.write");
  const prisma = db();
  try {
    return await prisma.tag.create({
      data: tenantData<Prisma.TagUncheckedCreateInput>({ nome: data.nome, cor: data.cor }),
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new TagJaExiste(data.nome);
    throw e;
  }
}

export async function renameTag(id: string, data: TagUpdate) {
  requireCan("tags.write");
  const prisma = db();
  await ensureTag(id);
  try {
    return await prisma.tag.update({ where: { id }, data: { nome: data.nome, cor: data.cor } });
  } catch (e) {
    if (isUniqueViolation(e)) throw new TagJaExiste(data.nome ?? "");
    throw e;
  }
}

/** Remove a tag (os vínculos ContactTag caem por cascade). */
export async function deleteTag(id: string) {
  requireCan("tags.write");
  const prisma = db();
  await ensureTag(id);
  await prisma.tag.delete({ where: { id } });
}

/** A tag atual de um contato (ou null). Com a regra de 1 tag, é no máximo uma. */
export async function getContactTag(contactId: string): Promise<TagWithCount | null> {
  const prisma = db();
  const row = await prisma.contactTag.findFirst({
    where: { contactId },
    include: { tag: true },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return { id: row.tag.id, nome: row.tag.nome, cor: row.tag.cor, count: 0 };
}

/**
 * Define (substitui) a tag de UM contato. `tagId` null limpa. Transação: apaga
 * as tags atuais e grava a nova — garante o invariante de 1 tag por contato.
 */
export async function setContactTag(contactId: string, tagId: string | null) {
  requireCan("tags.write");
  const prisma = db();
  // S1: sem isto, um ContactTag do meu time apontava para contato de outro time
  // (e o gatilho tag_added inscrevia esse contato nos meus fluxos).
  await assertOwned("contact", contactId);
  if (tagId) await ensureTag(tagId);
  await prisma.$transaction(async (tx) => {
    await tx.contactTag.deleteMany({ where: { contactId } });
    if (tagId) {
      await tx.contactTag.create({
        data: tenantData<Prisma.ContactTagUncheckedCreateInput>({ contactId, tagId }),
      });
    }
  });
  // Gatilho do motor: aplicar tag dispara fluxos tag_added dessa tag (não-fatal).
  if (tagId) await safeEnrollByTrigger("tag_added", { contactId, tagId });
}

/**
 * Atribuição em massa (mover N contatos para uma tag, ou tirar a tag). Mesma
 * regra de substituição, em lote e numa transação só.
 */
export async function assignTagBulk(contactIds: string[], tagId: string | null) {
  requireCan("tags.write");
  const prisma = db();
  if (contactIds.length === 0) return { updated: 0 };
  // S1: um id alheio no lote derruba a chamada inteira (ver assertOwnedMany).
  await assertOwnedMany("contact", contactIds);
  if (tagId) await ensureTag(tagId);
  await prisma.$transaction(async (tx) => {
    await tx.contactTag.deleteMany({ where: { contactId: { in: contactIds } } });
    if (tagId) {
      await tx.contactTag.createMany({
        data: contactIds.map((contactId) =>
          tenantData<Prisma.ContactTagCreateManyInput>({ contactId, tagId }),
        ),
        skipDuplicates: true,
      });
    }
  });
  // Gatilho do motor: mover em massa para uma tag inscreve cada contato nos
  // fluxos tag_added dessa tag (a "lista" do fluxo). Em LOTE (MF-13): antes era
  // um enrollByTrigger por contato, em série, dentro da requisição. Não-fatal.
  if (tagId) await safeEnrollManyByTrigger("tag_added", contactIds, { tagId, emLote: true });
  return { updated: contactIds.length };
}

/** Contatos por consulta e por gravação nos caminhos em lote. */
const LOTE = 1000;

/**
 * Põe UMA tag no contato sem tirar as outras. Já tinha → nada muda e o fluxo
 * "tag adicionada" não dispara de novo. Espelha o nome em `Contact.tags`
 * (campo antigo, que a exportação e as variáveis de campanha ainda leem).
 */
export async function addContactTag(contactId: string, tagId: string): Promise<{ adicionada: boolean }> {
  requireCan("tags.write");
  const prisma = db();
  await assertOwned("contact", contactId);
  const tag = await tagPorId(tagId);
  const { count } = await prisma.contactTag.createMany({
    data: [tenantData<Prisma.ContactTagCreateManyInput>({ contactId, tagId })],
    skipDuplicates: true,
  });
  await espelharNoLegado([contactId], { por: tag.nome });
  if (count === 1) await safeEnrollByTrigger("tag_added", { contactId, tagId });
  return { adicionada: count === 1 };
}

/** Tira UMA tag do contato (as outras ficam), no catálogo e no campo antigo. */
export async function removeContactTag(contactId: string, tagId: string): Promise<{ removida: boolean }> {
  requireCan("tags.write");
  const prisma = db();
  await assertOwned("contact", contactId);
  const tag = await tagPorId(tagId);
  const { count } = await prisma.contactTag.deleteMany({ where: { contactId, tagId } });
  await espelharNoLegado([contactId], { tirar: tag.nome });
  return { removida: count > 0 };
}

/**
 * Adiciona a tag a N contatos sem tirar as que eles têm. O gatilho "tag
 * adicionada" vale só para quem ainda não tinha a tag (em lote, MF-13).
 */
export async function addTagBulk(contactIds: string[], tagId: string): Promise<{ updated: number; jaTinham: number }> {
  requireCan("tags.write");
  const prisma = db();
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return { updated: 0, jaTinham: 0 };
  await assertOwnedMany("contact", ids);
  const tag = await tagPorId(tagId);
  const jaTem = new Set<string>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const achados = await prisma.contactTag.findMany({
      where: { tagId, contactId: { in: ids.slice(i, i + LOTE) } },
      select: { contactId: true },
    });
    for (const a of achados) jaTem.add(a.contactId);
  }
  const novos = ids.filter((id) => !jaTem.has(id));
  for (let i = 0; i < novos.length; i += LOTE) {
    await prisma.contactTag.createMany({
      data: novos.slice(i, i + LOTE).map((contactId) => tenantData<Prisma.ContactTagCreateManyInput>({ contactId, tagId })),
      skipDuplicates: true,
    });
  }
  await espelharNoLegado(ids, { por: tag.nome });
  if (novos.length) await safeEnrollManyByTrigger("tag_added", novos, { tagId, emLote: true });
  return { updated: novos.length, jaTinham: ids.length - novos.length };
}

/** Tira a tag de N contatos (as outras ficam). `updated` = quantos tinham a tag. */
export async function removeTagBulk(contactIds: string[], tagId: string): Promise<{ updated: number }> {
  requireCan("tags.write");
  const prisma = db();
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return { updated: 0 };
  await assertOwnedMany("contact", ids);
  const tag = await tagPorId(tagId);
  let updated = 0;
  for (let i = 0; i < ids.length; i += LOTE) {
    const { count } = await prisma.contactTag.deleteMany({ where: { tagId, contactId: { in: ids.slice(i, i + LOTE) } } });
    updated += count;
  }
  await espelharNoLegado(ids, { tirar: tag.nome });
  return { updated };
}

/**
 * Mantém `Contact.tags` (campo antigo) de acordo com o catálogo: põe ou tira o
 * nome, comparando sem caixa e sem acento. Sem isso a ficha, que mostra a união
 * dos dois, continuaria exibindo a tag tirada. Só grava quem muda.
 */
async function espelharNoLegado(contactIds: string[], mudanca: { por?: string; tirar?: string }) {
  const prisma = db();
  const chave = chaveDaTag(mudanca.por ?? mudanca.tirar ?? "");
  if (!chave) return;
  for (let i = 0; i < contactIds.length; i += LOTE) {
    const contatos = await prisma.contact.findMany({
      where: { id: { in: contactIds.slice(i, i + LOTE) } },
      select: { id: true, tags: true },
    });
    const mudar = contatos.flatMap((c) => {
      const tem = c.tags.some((n) => chaveDaTag(n) === chave);
      if (mudanca.por && !tem) return [{ id: c.id, tags: [...c.tags, mudanca.por] }];
      if (mudanca.tirar && tem) return [{ id: c.id, tags: c.tags.filter((n) => chaveDaTag(n) !== chave) }];
      return [];
    });
    // Sem transação: cada contato é independente, e um lote de 1000 updates estouraria o tempo dela.
    for (let j = 0; j < mudar.length; j += 25) {
      await Promise.all(
        mudar.slice(j, j + 25).map((c) => prisma.contact.update({ where: { id: c.id }, data: { tags: { set: c.tags } } })),
      );
    }
  }
}

async function tagPorId(id: string) {
  const prisma = db();
  const tag = await prisma.tag.findUnique({ where: { id }, select: { id: true, nome: true } });
  if (!tag) throw new TagNotFound(id);
  return tag;
}

async function ensureTag(id: string) {
  const prisma = db();
  const tag = await prisma.tag.findUnique({ where: { id }, select: { id: true } });
  if (!tag) throw new TagNotFound(id);
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "P2002";
}
