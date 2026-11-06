import {
  classificarProdutor,
  PRODUTOR_REGRA_VERSAO,
  type ClassifyProdutorInput,
} from "../produtor/classify";
import type { Enricher, EnrichmentResult } from "./types";

/** Alvo do ProdutorEnricher: um contato + os dados de CNPJ das suas empresas. */
export type ProdutorTarget = {
  contactId: string;
  /** Estado atual da classificação (para idempotência por versão). */
  produtorRegraVersao: string | null;
  /** Dados agregados das empresas do contato (já enriquecidas por CNPJ). */
  empresas: {
    cnae?: string | null;
    cnaesSecundarios?: string[];
    iesTipos?: { tipo?: string | null; habilitada?: boolean }[];
    razaoSocial?: string | null;
    nomeFantasia?: string | null;
    naturezaJuridica?: string | null;
  }[];
  nomeSocio?: string | null;
};

/**
 * ProdutorEnricher — aplica a regra determinística versionada (produtor/classify)
 * sobre os CNAEs/IEs das empresas do contato. Ver doc §3 + doc de produtor §2.
 *
 * Re-roda quando a versão da regra muda (idempotente): reprocessa e registra novo
 * Fact SEM apagar o antigo. Não usa IA — a zona cinzenta (`provavel_produtor`)
 * fica para o `AiEnricher` da Fase C.
 */
export const ProdutorEnricher: Enricher<ProdutorTarget> = {
  key: "produtor",
  version: PRODUTOR_REGRA_VERSAO,
  appliesTo: "contact",
  shouldRun(target) {
    if (target.empresas.length === 0) return false;
    // Roda se ainda não classificou OU se a regra subiu de versão.
    return target.produtorRegraVersao !== PRODUTOR_REGRA_VERSAO;
  },
  async run(target): Promise<EnrichmentResult | null> {
    if (target.empresas.length === 0) return null;

    // Agrega os sinais de TODAS as empresas do contato (o dono pode ter várias).
    const cnaesSecundarios: string[] = [];
    const ies: { tipo?: string | null; habilitada?: boolean }[] = [];
    let cnaePrincipal: string | null = null;
    const textos: string[] = [];
    let naturezaJuridica: string | null = null;

    for (const e of target.empresas) {
      if (!cnaePrincipal && e.cnae) cnaePrincipal = e.cnae;
      if (e.cnaesSecundarios) cnaesSecundarios.push(...e.cnaesSecundarios);
      if (e.iesTipos) ies.push(...e.iesTipos);
      if (e.razaoSocial) textos.push(e.razaoSocial);
      if (e.nomeFantasia) textos.push(e.nomeFantasia);
      if (!naturezaJuridica && e.naturezaJuridica) naturezaJuridica = e.naturezaJuridica;
    }

    const input: ClassifyProdutorInput = {
      cnaePrincipal,
      cnaesSecundarios,
      ies,
      razaoSocial: textos.join(" ") || null,
      nomeSocio: target.nomeSocio ?? null,
      naturezaJuridica,
    };
    const c = classificarProdutor(input);

    return {
      targetType: "contact",
      targetId: target.contactId,
      fields: [
        { field: "isProdutor", value: c.isProdutor },
        { field: "produtorScore", value: c.produtorScore },
        { field: "produtorLabel", value: c.produtorLabel },
        { field: "produtorRegraVersao", value: c.regraVersao },
      ],
      evidences: c.evidencias,
      confidence: 0.85,
      source: "regra",
      enricherKey: "produtor",
      enricherVersion: c.regraVersao,
      producedAt: new Date(),
    };
  },
};
