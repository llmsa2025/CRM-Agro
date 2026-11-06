import type { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { phoneVariants } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { isUniqueViolation } from "./errors";
import { ondeIdentificadorExato } from "./identificadores-cifra";
import { normalizeIdentifier } from "./identifiers";
import { escopoDoContato } from "./escopo";

/**
 * Complementos de um contato que já existe: só ACRESCENTAM, nunca trocam o que a pessoa digitou.
 * Usados pelo "Enriquecer pessoa" (telefone, e-mail e endereço que vêm das empresas dela).
 */

export type ResultadoDoComplemento = "adicionado" | "ja_tem" | "de_outro_contato" | "invalido";

/**
 * Acrescenta um telefone (canal WhatsApp) ou e-mail ao contato, como contato extra: o principal que já existe
 * continua sendo o principal. Se o contato não tinha nenhum no canal, o novo vira o principal. O valor que já é
 * do contato, ou de OUTRO contato do time, não é gravado de novo.
 */
export async function adicionarIdentificadorSeNovo(contactId: string, canal: "whatsapp" | "email", valorBruto: string): Promise<ResultadoDoComplemento> {
  requireCan("contacts.write");
  const prisma = db(); // antes de qualquer await (AGENTS.md §12)
  const teamId = getCurrentTeamId() ?? "";
  const valor = normalizeIdentifier(canal, valorBruto);
  if (!valor) return "invalido";
  const contato = await prisma.contact.findFirst({ where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] }, select: { id: true } });
  if (!contato) throw new Error("contato não encontrado no time");

  // Telefone: confere também a variante com e sem o nono dígito, para não cadastrar o mesmo número duas vezes.
  const valores = canal === "whatsapp" ? [...new Set([valor, ...phoneVariants(valor)])] : [valor];
  const dono = await prisma.channelIdentifier.findFirst({ where: ondeIdentificadorExato(teamId, canal, valores), select: { contactId: true } });
  if (dono) return dono.contactId === contactId ? "ja_tem" : "de_outro_contato";

  const temPrincipal = (await prisma.channelIdentifier.count({ where: { contactId, canal } })) > 0;
  try {
    await prisma.channelIdentifier.create({
      data: tenantData<Prisma.ChannelIdentifierUncheckedCreateInput>({ contactId, canal, valor, isPrimary: !temPrincipal }),
    });
  } catch (e) {
    if (isUniqueViolation(e)) return "de_outro_contato";
    throw e;
  }
  return "adicionado";
}

/** Grava endereço, cidade e estado só onde o contato ainda está vazio. Devolve se mudou alguma coisa. */
export async function completarEnderecoDoContato(contactId: string, e: { endereco?: string | null; cidade?: string | null; estado?: string | null }): Promise<boolean> {
  requireCan("contacts.write");
  const prisma = db();
  const atual = await prisma.contact.findFirst({ where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] }, select: { endereco: true, cidade: true, estado: true } });
  if (!atual) throw new Error("contato não encontrado no time");
  const patch: Prisma.ContactUpdateInput = {};
  const t = (v: string | null | undefined) => (v ?? "").trim();
  if (!t(atual.endereco) && t(e.endereco)) patch.endereco = t(e.endereco);
  if (!t(atual.cidade) && t(e.cidade)) patch.cidade = t(e.cidade);
  if (!t(atual.estado) && t(e.estado)) patch.estado = t(e.estado).toUpperCase();
  if (!Object.keys(patch).length) return false;
  await prisma.contact.update({ where: { id: contactId }, data: patch });
  return true;
}
