import type { Canal, Prisma } from "@prisma/client";
import { db, getCurrentTeamId } from "@crmagro/db";
import { ondeIdentificadoresExatos, valorDe } from "../contacts/identificadores-cifra";
import { normalizeIdentifier } from "../contacts/identifiers";
import { escopoDoContato } from "../contacts/escopo";

/** O mínimo de um rascunho para achar os contatos a que ele está vinculado. */
export type RascunhoDedup = { id: string; origem: string; telefone: string | null; email: string | null; cnpj: string | null; extra: Prisma.JsonValue | null };

/** Chaves de dedup de um rascunho ("canal:valor", normalizadas como os identifiers do contato). */
export function chavesDoRascunho(r: RascunhoDedup): string[] {
  const chaves: string[] = [];
  const tel = r.telefone ? normalizeIdentifier("whatsapp", r.telefone) : null;
  const email = r.email ? normalizeIdentifier("email", r.email) : null;
  const username = r.origem === "instagram" ? (r.extra as { username?: unknown } | null)?.username : null;
  const ig = typeof username === "string" ? normalizeIdentifier("instagram", username) : null;
  if (email) chaves.push(`email:${email}`);
  if (tel) chaves.push(`whatsapp:${tel}`);
  if (ig) chaves.push(`instagram:${ig}`);
  if (r.cnpj) chaves.push(`cnpj:${r.cnpj}`);
  return chaves;
}

export type ContatoVinculado = { id: string; nome: string };

/**
 * A que contatos o rascunho está vinculado, para a linha da captação mostrar
 * "Contato: Fulano +2" no lugar de só o responsável.
 * - `contato`: o primeiro entre os que a pessoa pode VER (mesmo escopo da lista
 *   de Contatos: quem vê só os seus não recebe o nome do contato do colega);
 * - `outros`: quantos além desse, também entre os visíveis.
 * Quando o vínculo existe mas nenhum contato é visível, `contato` é null (a
 * tela mostra só "já cadastrado").
 */
export type VinculoDoRascunho = { contato: ContatoVinculado | null; outros: number };

/**
 * Vínculo em LOTE: id do rascunho → contatos. Só entra no mapa o rascunho que
 * achou ao menos um contato do time. Vínculo por telefone, e-mail ou perfil
 * (identificadores do contato), pelo CNPJ gravado no contato e pelo CNPJ de uma
 * empresa ligada ao contato (`ContactCompany`). No total são 4 consultas para a
 * página inteira, nunca uma por linha. Tudo por `db()`: a extensão prende ao
 * time do contexto, então contato de outro time nunca entra.
 */
export async function vinculosDosRascunhos(rascunhos: readonly RascunhoDedup[]): Promise<Map<string, VinculoDoRascunho>> {
  const resultado = new Map<string, VinculoDoRascunho>();
  const prisma = db();
  const teamId = getCurrentTeamId();
  if (!teamId) return resultado;

  const chavesDe = new Map<string, string[]>();
  const idents: { canal: Canal; valor: string }[] = [];
  const cnpjs = new Set<string>();
  for (const r of rascunhos) {
    const chaves = chavesDoRascunho(r);
    if (!chaves.length) continue;
    chavesDe.set(r.id, chaves);
    for (const k of chaves) {
      const i = k.indexOf(":");
      const canal = k.slice(0, i);
      const valor = k.slice(i + 1);
      if (canal === "cnpj") cnpjs.add(valor);
      else idents.push({ canal: canal as Canal, valor });
    }
  }
  if (!idents.length && !cnpjs.size) return resultado;

  const listaCnpj = [...cnpjs];
  const [porIdent, porCnpj, porEmpresa] = await Promise.all([
    idents.length
      ? prisma.channelIdentifier.findMany({
          where: ondeIdentificadoresExatos(teamId, idents),
          select: { canal: true, valor: true, valorCifrado: true, contactId: true },
        })
      : Promise.resolve([]),
    listaCnpj.length ? prisma.contact.findMany({ where: { cnpj: { in: listaCnpj } }, select: { id: true, cnpj: true } }) : Promise.resolve([]),
    listaCnpj.length
      ? prisma.contactCompany.findMany({ where: { company: { cnpj: { in: listaCnpj } } }, select: { contactId: true, company: { select: { cnpj: true } } } })
      : Promise.resolve([]),
  ]);

  // chave ("canal:valor" ou "cnpj:dígitos") → ids dos contatos, sem repetir.
  const porChave = new Map<string, Set<string>>();
  const ligar = (chave: string, contactId: string) => {
    const s = porChave.get(chave) ?? new Set<string>();
    s.add(contactId);
    porChave.set(chave, s);
  };
  for (const i of porIdent) ligar(`${i.canal}:${valorDe(i)}`, i.contactId);
  for (const c of porCnpj) if (c.cnpj) ligar(`cnpj:${c.cnpj}`, c.id);
  for (const c of porEmpresa) if (c.company?.cnpj) ligar(`cnpj:${c.company.cnpj}`, c.contactId);
  if (!porChave.size) return resultado;

  // Quais desses contatos a pessoa pode VER (mesmo escopo da lista de Contatos).
  const todos = new Set<string>();
  for (const s of porChave.values()) for (const id of s) todos.add(id);
  const visiveis = await prisma.contact.findMany({
    where: { AND: [{ id: { in: [...todos] } }, escopoDoContato()] },
    select: { id: true, nome: true },
    orderBy: [{ nome: "asc" }, { id: "asc" }],
  });
  const nomeDe = new Map(visiveis.map((c) => [c.id, c.nome]));

  for (const [rascunhoId, chaves] of chavesDe) {
    // Ordem estável: a ordem das chaves do rascunho (e-mail, telefone, perfil,
    // CNPJ); dentro da mesma chave, por nome.
    const ids: string[] = [];
    for (const k of chaves) {
      const doGrupo = [...(porChave.get(k) ?? [])].sort((a, b) => (nomeDe.get(a) ?? "").localeCompare(nomeDe.get(b) ?? "", "pt-BR") || a.localeCompare(b));
      for (const id of doGrupo) if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) continue;
    const contatos = ids.filter((id) => nomeDe.has(id)).map((id) => ({ id, nome: nomeDe.get(id)! }));
    resultado.set(rascunhoId, { contato: contatos[0] ?? null, outros: Math.max(contatos.length - 1, 0) });
  }
  return resultado;
}
