import { db } from "@crmagro/db";
import { enrichContactFromCnpj } from "../companies/service";
import { enriquecerEmpresasDoContatoAutomatico } from "../enrichment/empresa";
import { enriquecerPessoaAutomatico } from "../enrichment/pessoa";

/**
 * Passo `enrich_data` (ANTIGO, segue funcionando; o editor avisa e oferece trocar por "Enriquecer empresa" ou "Enriquecer pessoa"): completa o cadastro a partir do CNPJ das empresas do contato (IE, e-mail, telefone,
 * endereço, cidade, UF, CNAE), só no que está vazio. Hoje só o CNPJ tem consulta pública. IE sem CNPJ e CPF ficam
 * para depois: sem CNPJ o passo pula e diz por quê.
 */
export async function enriquecerContatoDoFluxo(contactId: string): Promise<{ skipped: boolean; motivo: string }> {
  const empresas = await db().contactCompany.findMany({ where: { contactId }, select: { company: { select: { cnpj: true } } } });
  if (empresas.length === 0) return { skipped: true, motivo: "Sem empresa cadastrada para consultar" };
  const comCnpj = empresas.filter((e) => e.company.cnpj).length;
  if (comCnpj === 0) return { skipped: true, motivo: "Nenhuma empresa com CNPJ para consultar (IE e CPF ainda não têm consulta automática)" };

  const r = await enrichContactFromCnpj(contactId);
  if (r.fieldsFilled.length > 0) {
    const lista = r.fieldsFilled.slice(0, 6).join(", ");
    return { skipped: false, motivo: `Preencheu ${r.fieldsFilled.length} campo(s): ${lista}${r.fieldsFilled.length > 6 ? "…" : ""}` };
  }
  if (r.falhas >= comCnpj) return { skipped: true, motivo: "A consulta de CNPJ não respondeu agora" };
  return { skipped: false, motivo: `${comCnpj} CNPJ consultado(s), nada novo para preencher` };
}

/**
 * Passo `enrich_company` (Enriquecer empresa): consulta o CNPJ das empresas do contato e preenche só o que está vazio,
 * com a fonte e a data de cada campo (EnrichmentFact + `Company.enrichment.campos`). Só confiança alta ou média; nunca
 * troca valor existente, nunca guarda o e-mail do contador, não lê o site.
 */
export async function enriquecerEmpresaDoFluxo(contactId: string): Promise<{ skipped: boolean; motivo: string }> {
  const empresas = await db().contactCompany.findMany({ where: { contactId }, select: { company: { select: { cnpj: true } } } });
  if (empresas.length === 0) return { skipped: true, motivo: "Sem empresa cadastrada para consultar" };
  const comCnpj = empresas.filter((e) => e.company.cnpj).length;
  if (comCnpj === 0) return { skipped: true, motivo: "Nenhuma empresa com CNPJ para consultar" };
  const r = await enriquecerEmpresasDoContatoAutomatico(contactId);
  if (r.campos.length > 0) {
    const lista = r.campos.slice(0, 6).join(", ");
    return { skipped: false, motivo: `Preencheu ${r.campos.length} campo(s): ${lista}${r.campos.length > 6 ? "…" : ""}` };
  }
  if (r.avisos.length >= comCnpj) return { skipped: true, motivo: "A consulta de CNPJ não respondeu agora" };
  return { skipped: false, motivo: `${comCnpj} CNPJ consultado(s), nada novo para preencher` };
}

/**
 * Passo `enrich_person` (Enriquecer pessoa): com o CPF guardado no contato e o nome, acha na fonte gratuita as empresas em
 * que ele é sócio ou dono e as vincula (só confiança alta; `incluirConfiancaMedia` liga as de nome parecido). Sem CPF no
 * cadastro o passo pula e diz por quê. Nunca consulta fonte paga.
 */
export async function enriquecerPessoaDoFluxo(
  contactId: string,
  opts: { incluirConfiancaMedia?: boolean } = {},
): Promise<{ skipped: boolean; motivo: string }> {
  const r = await enriquecerPessoaAutomatico(contactId, opts);
  return { skipped: r.skipped, motivo: r.motivo };
}
