import { db } from "@crmagro/db";
import type { ContactVars } from "../flows/executor";
import { primaryEmail, primaryTelefone } from "../contacts/identifiers";
import { lerCpf } from "../contacts/cpf";

/**
 * Variáveis de mensagem de vários contatos numa consulta (prévia e envio da
 * campanha). Mesmo mapeamento do worker do motor (`apps/worker/src/handler.ts`,
 * "contactVars"): empresa PRINCIPAL (1º vínculo) com fallback nos campos legados
 * da pessoa — a prévia e o envio precisam dar o mesmo texto que um fluxo daria.
 */
export async function carregarVariaveis(contactIds: string[]): Promise<Map<string, ContactVars>> {
  const out = new Map<string, ContactVars>();
  if (contactIds.length === 0) return out;
  const contatos = await db().contact.findMany({
    where: { id: { in: [...new Set(contactIds)] } },
    select: {
      id: true,
      nome: true,
      tags: true,
      ownerId: true,
      sobrenome: true,
      empresa: true,
      cargo: true,
      cidade: true,
      estado: true,
      cpfCifrado: true,
      cnpj: true,
      site: true,
      identifiers: { select: { canal: true, valor: true, valorCifrado: true, isPrimary: true } },
      companies: {
        take: 1,
        orderBy: { createdAt: "asc" },
        select: {
          company: {
            select: { nome: true, cnpj: true, ie: true, cidade: true, estado: true, site: true, telefone: true, email: true },
          },
        },
      },
    },
  });
  for (const k of contatos) {
    const ids = k.identifiers ?? [];
    const co = k.companies?.[0]?.company ?? null;
    out.set(k.id, {
      id: k.id,
      nome: k.nome,
      tags: k.tags,
      ownerId: k.ownerId,
      sobrenome: k.sobrenome,
      empresa: co?.nome ?? k.empresa,
      cargo: k.cargo,
      cidade: k.cidade,
      estado: k.estado,
      cpf: lerCpf(k.cpfCifrado),
      cnpj: k.cnpj,
      site: k.site,
      email: primaryEmail(ids),
      telefone: primaryTelefone(ids),
      instagram: ids.find((i) => i.canal === "instagram")?.valor ?? null,
      linkedin: ids.find((i) => i.canal === "linkedin")?.valor ?? null,
      empresaCnpj: co?.cnpj ?? k.cnpj,
      empresaIe: co?.ie ?? null,
      empresaCidade: co?.cidade ?? null,
      empresaEstado: co?.estado ?? null,
      empresaSite: co?.site ?? k.site,
      empresaTelefone: co?.telefone ?? null,
      empresaEmail: co?.email ?? null,
    });
  }
  return out;
}
