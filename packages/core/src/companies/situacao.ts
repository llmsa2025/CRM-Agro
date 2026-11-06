import type { Prisma } from "@prisma/client";
import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { consultarCnpjDetalhado } from "../captacao/cnpj";
import { escopoDoContato } from "../contacts/escopo";

/**
 * Situação cadastral da empresa na Receita (ativa ou não), guardada em `Company.enrichment.situacao` (JSON, sem
 * coluna nova). Aparece como "Ativa" / "Inativa" no card de empresas do contato, para quem quer limpar as baixadas.
 */

export type SituacaoDaEmpresa = {
  ativa: boolean;
  /** Texto da Receita ("ATIVA", "BAIXADA", "INAPTA"...), quando veio. */
  descricao: string | null;
  consultadoEm: string;
  fonteRotulo: string;
};

/** "ATIVA" e "Ativa" são ativas; baixada, inapta, suspensa e nula não. Sem texto, não dá para dizer (null). */
export function situacaoEhAtiva(descricao: string | null | undefined): boolean | null {
  const t = (descricao ?? "").trim();
  if (!t) return null;
  return /^ativa$/i.test(t);
}

/** Grava a situação em `Company.enrichment.situacao`, sem mexer no resto do JSON. */
export async function registrarSituacaoDaEmpresa(companyId: string, s: SituacaoDaEmpresa): Promise<void> {
  requireCan("contacts.write");
  const prisma = db(); // antes de qualquer await (AGENTS.md §12)
  const empresa = await prisma.company.findFirst({ where: { id: companyId }, select: { enrichment: true } });
  if (!empresa) return;
  const atual = (empresa.enrichment && typeof empresa.enrichment === "object" ? empresa.enrichment : {}) as Record<string, unknown>;
  await prisma.company.update({ where: { id: companyId }, data: { enrichment: { ...atual, situacao: s } as Prisma.InputJsonValue } });
}

export type ResultadoDaConferencia = { conferidas: number; inativas: number; semResposta: number };

export const CONFERIR_SITUACAO_MAX_EMPRESAS = 20;

/**
 * Consulta a situação de cada empresa com CNPJ vinculada ao contato (cache de 30 dias, depois BrasilAPI e
 * OpenCNPJ, tudo de graça) e grava. Serve para as empresas que foram vinculadas antes de o CRM Agro guardar isso.
 */
export async function conferirSituacaoDasEmpresas(
  contactId: string,
  deps: { consultarCnpj?: typeof consultarCnpjDetalhado; agora?: () => Date } = {},
): Promise<ResultadoDaConferencia> {
  requireCan("contacts.write");
  const prisma = db();
  const contato = await prisma.contact.findFirst({ where: { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] }, select: { id: true } });
  if (!contato) throw new Error("contato não encontrado no time");
  const links = await prisma.contactCompany.findMany({ where: { contactId }, select: { company: { select: { id: true, cnpj: true } } }, take: CONFERIR_SITUACAO_MAX_EMPRESAS });
  const consultar = deps.consultarCnpj ?? consultarCnpjDetalhado;
  const out: ResultadoDaConferencia = { conferidas: 0, inativas: 0, semResposta: 0 };
  for (const { company } of links) {
    if (!company.cnpj) continue;
    try {
      const { resultado } = await consultar(company.cnpj);
      const ativa = situacaoEhAtiva(resultado.situacao);
      if (ativa === null) {
        out.semResposta++;
        continue;
      }
      await registrarSituacaoDaEmpresa(company.id, {
        ativa,
        descricao: resultado.situacao,
        consultadoEm: (resultado.consultadoEm ?? (deps.agora?.() ?? new Date()).toISOString()),
        fonteRotulo: "Receita Federal (consulta de CNPJ)",
      });
      out.conferidas++;
      if (!ativa) out.inativas++;
    } catch {
      out.semResposta++;
    }
  }
  return out;
}
