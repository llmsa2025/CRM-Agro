import { db } from "@crmagro/db";
import type { Enricher } from "./types";
import { applyEnrichment } from "./reconcile";
import { CnpjEnricher } from "./cnpj";
import { ProdutorEnricher, type ProdutorTarget } from "./produtor";

/**
 * Registry de enrichers. Adicionar um enricher novo (ex.: TemPropriedadeEnricher da
 * Fase D) = 1 item aqui — mesmo padrão plugável da interface `Channel`. Ver doc §3.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const enrichers: Enricher<any>[] = [CnpjEnricher, ProdutorEnricher];

/**
 * Pipeline de enriquecimento de um CONTATO (tenant-scoped via db()):
 *  1. para cada empresa com CNPJ, roda o CnpjEnricher (preenche CNAE/IE/…);
 *  2. reclassifica o contato com o ProdutorEnricher sobre as empresas atualizadas.
 * Devolve o resumo do que foi promovido a coluna dedicada.
 */
export async function runEnrichmentForContact(
  contactId: string,
): Promise<{ companiesEnriched: number; produtorLabel: string | null; applied: string[] }> {
  const prisma = db();
  const applied: string[] = [];

  const links = await prisma.contactCompany.findMany({
    where: { contactId },
    include: { company: true },
  });

  // 1) CNPJ por empresa (fill-only — não pisa no que o humano digitou).
  let companiesEnriched = 0;
  for (const link of links) {
    const co = link.company;
    if (!(await Promise.resolve(CnpjEnricher.shouldRun({ id: co.id, cnpj: co.cnpj, cnae: co.cnae })))) continue;
    try {
      const res = await CnpjEnricher.run({ id: co.id, cnpj: co.cnpj, cnae: co.cnae }, {});
      if (res) {
        const { applied: a } = await applyEnrichment(res, { mode: "fill-only" });
        applied.push(...a.map((f) => `empresa.${f}`));
        companiesEnriched++;
      }
    } catch {
      // falha numa empresa não derruba o pipeline.
    }
  }

  // 2) Produtor sobre as empresas ATUALIZADAS.
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { produtorRegraVersao: true },
  });
  const companies = await prisma.contactCompany.findMany({
    where: { contactId },
    include: { company: true },
  });
  const target: ProdutorTarget = {
    contactId,
    produtorRegraVersao: contact?.produtorRegraVersao ?? null,
    empresas: companies.map((l) => ({
      cnae: l.company.cnae,
      cnaesSecundarios: l.company.cnaesSecundarios,
      iesTipos: (l.company.iesTipos as ProdutorTarget["empresas"][number]["iesTipos"]) ?? [],
      razaoSocial: l.company.nome,
      naturezaJuridica: l.company.naturezaJuridica,
    })),
  };

  let produtorLabel: string | null = null;
  if (await Promise.resolve(ProdutorEnricher.shouldRun(target))) {
    const res = await ProdutorEnricher.run(target, {});
    if (res) {
      // Campo de máquina: reclassificação deve atualizar o rótulo (mas nunca sobre
      // valor humano — o reconciler protege via never-override-human).
      const { applied: a } = await applyEnrichment(res, { mode: "prefer-higher-confidence" });
      applied.push(...a);
      produtorLabel = (res.fields.find((f) => f.field === "produtorLabel")?.value as string) ?? null;
    }
  }

  return { companiesEnriched, produtorLabel, applied };
}
