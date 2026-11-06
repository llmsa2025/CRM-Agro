/**
 * Contrato do pipeline de ENRIQUECIMENTO versionado. Ver
 * a documentação interna §3.
 *
 * Regra que mata a dor: um Enricher NUNCA escreve no banco — ele apenas PRODUZ um
 * resultado (fields + evidências + confiança + fonte + versão). Quem decide gravar
 * é o reconciler `applyEnrichment` (fill-only / never-override-human). Todo
 * resultado vira um `EnrichmentFact` imutável (auditoria/versão), e a coluna
 * dedicada guarda o "vencedor promovido". Plugável como a interface `Channel`.
 */

export type EnrichTargetType = "contact" | "company";

/** Um campo produzido (nome da coluna dedicada + valor). */
export type EnrichField = { field: string; value: unknown };

/** Resultado de um enricher (imutável, nunca escrito direto no banco). */
export type EnrichmentResult = {
  targetType: EnrichTargetType;
  targetId: string;
  fields: EnrichField[];
  evidences?: unknown[];
  confidence: number; // 0–1 (humano = 1)
  source: string; // "cnpja" | "brasilapi" | "regra" | "ai" | "human"
  enricherKey: string;
  enricherVersion: string;
  producedAt: Date;
};

/** Contexto passado ao `run` (extensível — hoje só o teamId implícito via db()). */
export type EnrichmentCtx = Record<string, never>;

export interface Enricher<T = unknown> {
  key: string; // ex.: "cnpj", "produtor"
  version: string; // VERSIONADO: "cnpj@1", "produtor@2026-08-11"
  appliesTo: EnrichTargetType;
  /** Idempotência: já rodou nesta versão? Compara com o estado atual do alvo. */
  shouldRun(target: T): boolean | Promise<boolean>;
  /** Produz o resultado (ou null se nada a fazer). NÃO escreve no banco. */
  run(target: T, ctx: EnrichmentCtx): Promise<EnrichmentResult | null>;
}

/**
 * Política do reconciler:
 *  - "fill-only": só preenche coluna vazia (default — vira o `mode` padrão);
 *  - "prefer-higher-confidence": sobrescreve se a confiança nova for maior;
 *  - "never-override-human": nunca sobrescreve valor de fonte humana (confidence 1).
 * `fill-only` já embute `never-override-human` (não toca no que existe).
 */
export type ApplyMode = "fill-only" | "prefer-higher-confidence" | "never-override-human";
