import { consultarCnpj } from "../captacao/cnpj";
import type { Enricher, EnrichmentResult } from "./types";

/** Alvo do CnpjEnricher: uma empresa com CNPJ. */
export type CompanyTarget = {
  id: string;
  cnpj: string | null;
  cnae: string | null;
};

/**
 * CnpjEnricher — encapsula `consultarCnpj` (cache compartilhado + fichas do
 * CNPJá → BrasilAPI; item 3.2, INT-13). Depende do fix que
 * parou de descartar `sideActivities`/`registrations[].type` (fetch.ts): sem ele o
 * classificador de produtor fica cego. Ver doc §3.
 *
 * Produz os campos de EMPRESA (nunca escreve direto — o reconciler decide). A
 * confiança é alta (dado oficial da Receita/Sintegra), mas fill-only garante que
 * não pisa no que o humano digitou.
 */
export const CnpjEnricher: Enricher<CompanyTarget> = {
  key: "cnpj",
  version: "cnpj@1",
  appliesTo: "company",
  shouldRun(target) {
    // Roda se tem CNPJ e ainda não tem o CNAE persistido (idempotente por versão:
    // subir a versão do enricher fará re-rodar mesmo com CNAE preenchido).
    return !!target.cnpj && !target.cnae;
  },
  async run(target): Promise<EnrichmentResult | null> {
    if (!target.cnpj) return null;
    const r = await consultarCnpj(target.cnpj);
    const source = r.fonte; // origem gravada pela consulta (antes era heurística)
    return {
      targetType: "company",
      targetId: target.id,
      fields: [
        { field: "cnae", value: r.cnae },
        { field: "cnaesSecundarios", value: r.cnaesSecundarios.map((c) => c.codigo) },
        { field: "iesTipos", value: r.ies },
        { field: "ie", value: r.ie },
        { field: "email", value: r.email },
        { field: "telefone", value: r.telefone },
        { field: "endereco", value: r.endereco },
        { field: "cidade", value: r.cidade },
        { field: "estado", value: r.uf },
      ],
      evidences: [{ fonte: source, situacao: r.situacao, cnaeDescricao: r.cnaeDescricao }],
      confidence: 0.8,
      source,
      enricherKey: "cnpj",
      enricherVersion: "cnpj@1",
      producedAt: new Date(),
    };
  },
};
