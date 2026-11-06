import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { safeEnrollByTrigger } from "../flows/triggers";
import { assertOwned } from "../tenancy/assert-owned";
import { TagNomeVazio, TagNotFound } from "./errors";

/**
 * Tag pelo NOME (o passo "Adicionar tag" do motor guarda o nome digitado, não um id).
 *
 * A tela de Contatos lê o catálogo `Tag` e o vínculo `ContactTag` (`tagFilterSummary`). O passo antigo só empurrava o
 * texto para `Contact.tags` (campo legado), então a tag nunca existia no catálogo e não aparecia na barra nem no
 * filtro. Aqui o nome vira tag do time
 * (criada se não existir, sem duplicar por caixa nem por acento) e o contato é vinculado a ela.
 *
 * O campo "Tags" do formulário e a planilha importada passam pela mesma ponte, em lote e por lista, em `do-contato.ts`
 *.
 */

/** Limite do cadastro manual de tag (`tagCreateSchema`). */
export const TAG_NOME_MAX = 40;

/** Nome para gravar no catálogo: espaços colapsados e no máximo `TAG_NOME_MAX` caracteres. */
export function nomeDaTag(bruto: string): string {
  return bruto.replace(/\s+/g, " ").trim().slice(0, TAG_NOME_MAX).trim();
}

/** Chave de comparação: sem acento e sem caixa ("Cliente Prioritário" e "cliente prioritario" são a mesma tag). */
export function chaveDaTag(nome: string): string {
  return nomeDaTag(nome).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

/**
 * Acha a tag do time pelo nome (ignorando caixa e acento) ou cria. Corrida (dois passos criando o mesmo nome ao mesmo
 * tempo): o índice único do banco barra o segundo, que relê e usa a tag que ganhou.
 */
export async function garantirTagPorNome(bruto: string): Promise<{ id: string; nome: string; criada: boolean }> {
  requireCan("tags.write");
  const nome = nomeDaTag(bruto);
  if (!nome) throw new TagNomeVazio();
  const prisma = db();
  const chave = chaveDaTag(nome);
  const achar = async () => {
    const exata = await prisma.tag.findFirst({ where: { nome }, select: { id: true, nome: true } });
    if (exata) return exata;
    // Outra caixa ou outro acento: o catálogo do time é pequeno, compara na memória.
    const todas = await prisma.tag.findMany({ select: { id: true, nome: true }, orderBy: { createdAt: "asc" }, take: 5000 });
    return todas.find((t) => chaveDaTag(t.nome) === chave) ?? null;
  };
  const existente = await achar();
  if (existente) return { ...existente, criada: false };
  // `INSERT ... ON CONFLICT DO NOTHING`: se outro passo criou o mesmo nome agora há pouco, não há erro nem linha de
  // erro no log do banco; `count` diz quem criou.
  const { count } = await prisma.tag.createMany({ data: [tenantData<Prisma.TagCreateManyInput>({ nome })], skipDuplicates: true });
  const tag = await achar();
  if (!tag) throw new TagNotFound(nome); // só se apagarem a tag nesse instante
  return { ...tag, criada: count === 1 };
}

/**
 * Adiciona a tag (pelo nome) ao contato: garante a tag no catálogo e vincula, SEM tirar as outras que o contato tem
 * (a regra de uma tag por contato é da atribuição manual da tela de Contatos; o passo do fluxo "adiciona"). Idempotente:
 * repetir não duplica. Vínculo NOVO dispara os fluxos de gatilho "tag adicionada" dessa tag, como a atribuição manual
 * (não-fatal, e `profundidade` mantém o limite de cascata do motor).
 */
export async function adicionarTagPorNome(
  contactId: string,
  bruto: string,
  opts: { profundidade?: number } = {},
): Promise<{ tagId: string; nome: string; tagCriada: boolean; vinculada: boolean }> {
  requireCan("tags.write");
  await assertOwned("contact", contactId);
  const tag = await garantirTagPorNome(bruto);
  // `count` 0 = o contato já tinha a tag (índice único [contactId, tagId], sem erro).
  const { count } = await db().contactTag.createMany({ data: [tenantData<Prisma.ContactTagCreateManyInput>({ contactId, tagId: tag.id })], skipDuplicates: true });
  const vinculada = count === 1;
  if (vinculada) await safeEnrollByTrigger("tag_added", { contactId, tagId: tag.id, profundidade: opts.profundidade ?? 0 });
  return { tagId: tag.id, nome: tag.nome, tagCriada: tag.criada, vinculada };
}

/** O contato tem uma tag com este nome (ignora caixa e acento) no catálogo? Leitura, sem papel. */
export async function contatoTemATag(contactId: string, bruto: string): Promise<boolean> {
  const chave = chaveDaTag(bruto);
  if (!chave) return false;
  const vinculos = await db().contactTag.findMany({ where: { contactId }, select: { tag: { select: { nome: true } } } });
  return vinculos.some((v) => chaveDaTag(v.tag.nome) === chave);
}
