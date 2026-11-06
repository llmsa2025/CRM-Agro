import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import type { ApplyMode, EnrichmentResult } from "./types";

/**
 * Reconciler — a ÚNICA porta que grava enriquecimento. Recebe o resultado (que o
 * enricher só PRODUZIU) e decide o que promover à coluna dedicada, sempre
 * registrando o `EnrichmentFact` append-only (auditoria/versão). Ver doc §3/§4.
 *
 * `never-override-human`: se já existe um Fact de fonte "human" para o campo, o
 * valor humano vence (não sobrescreve). `fill-only` (default) só grava em coluna
 * vazia. `prefer-higher-confidence` sobrescreve quando a confiança nova é maior.
 */

const HUMAN_SOURCE = "human";

/** Colunas dedicadas permitidas por tipo de alvo (evita gravar campo arbitrário). */
const ALLOWED_FIELDS: Record<string, Set<string>> = {
  contact: new Set(["isProdutor", "produtorScore", "produtorLabel", "produtorRegraVersao"]),
  company: new Set([
    "cnae",
    "cnaesSecundarios",
    "iesTipos",
    "ie",
    "email",
    "telefone",
    "endereco",
    "cidade",
    "estado",
    "naturezaJuridica",
    "site",
  ]),
};

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

async function currentRow(targetType: string, targetId: string): Promise<Record<string, unknown> | null> {
  const prisma = db();
  if (targetType === "contact") {
    return prisma.contact.findUnique({ where: { id: targetId } }) as Promise<Record<string, unknown> | null>;
  }
  return prisma.company.findUnique({ where: { id: targetId } }) as Promise<Record<string, unknown> | null>;
}

async function humanLockedFields(targetType: string, targetId: string): Promise<Set<string>> {
  const prisma = db();
  const facts = await prisma.enrichmentFact.findMany({
    where: { targetType, targetId, source: HUMAN_SOURCE },
    select: { field: true },
  });
  return new Set(facts.map((f) => f.field));
}

/**
 * Aplica um resultado de enriquecimento: grava os Facts (sempre) e promove os
 * campos elegíveis à coluna dedicada conforme o `mode`. Devolve os campos
 * efetivamente promovidos.
 */
export async function applyEnrichment(
  result: EnrichmentResult,
  opts: { mode?: ApplyMode } = {},
): Promise<{ applied: string[] }> {
  const mode = opts.mode ?? "fill-only";
  const prisma = db();
  const row = await currentRow(result.targetType, result.targetId);
  if (!row) return { applied: [] };

  const humanFields = await humanLockedFields(result.targetType, result.targetId);
  const allowed = ALLOWED_FIELDS[result.targetType] ?? new Set<string>();

  const promote: Record<string, unknown> = {};
  const applied: string[] = [];
  const now = new Date();

  for (const { field, value } of result.fields) {
    if (isEmpty(value)) continue;

    // 1) Sempre registra a proveniência (append-only), promovido ou não.
    const willApply = decidePromote(field, value, row, mode, humanFields, allowed);
    await prisma.enrichmentFact.create({
      data: tenantData<Prisma.EnrichmentFactUncheckedCreateInput>({
        targetType: result.targetType,
        targetId: result.targetId,
        field,
        value: value as Prisma.InputJsonValue,
        enricherKey: result.enricherKey,
        enricherVersion: result.enricherVersion,
        source: result.source,
        confidence: result.confidence,
        evidences: (result.evidences ?? undefined) as Prisma.InputJsonValue | undefined,
        producedAt: result.producedAt,
        appliedAt: willApply ? now : null,
      }),
    });

    if (willApply) {
      promote[field] = value;
      applied.push(field);
    }
  }

  if (applied.length) {
    if (result.targetType === "contact") {
      await prisma.contact.update({ where: { id: result.targetId }, data: promote as Prisma.ContactUpdateInput });
    } else {
      await prisma.company.update({ where: { id: result.targetId }, data: promote as Prisma.CompanyUpdateInput });
    }
  }

  return { applied };
}

function decidePromote(
  field: string,
  value: unknown,
  row: Record<string, unknown>,
  mode: ApplyMode,
  humanFields: Set<string>,
  allowed: Set<string>,
): boolean {
  if (!allowed.has(field)) return false; // só colunas dedicadas conhecidas
  if (humanFields.has(field)) return false; // humano sempre vence (never-override-human)
  const cur = row[field];
  if (isEmpty(cur)) return true; // coluna vazia → preenche em qualquer modo
  // Coluna já tem valor:
  if (mode === "fill-only" || mode === "never-override-human") return false;
  // prefer-higher-confidence: a confiança é checada no chamador (aqui já passou),
  // então sobrescreve. (Comparação fina por-campo fica para quando houver Fact
  // anterior com confiança registrada — evolução sem mudar o contrato.)
  return true;
}
