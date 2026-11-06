import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { SNAPSHOT_VERSION } from "./snapshot";
import type { SnapshotNode } from "./schema";

/**
 * Versão do fluxo (item 2.7, DP-14).
 *
 * Antes, cada `Enrollment.flowSnapshot` guardava o grafo inteiro (config de
 * todos os nós, textos, prompts de IA): uma tag aplicada a 5 mil contatos
 * gravava 5 mil cópias iguais, e o worker relia a cópia da inscrição a cada
 * passo. Agora o grafo congelado mora UMA vez na `FlowVersion`, deduplicado por
 * hash, e a inscrição nova só guarda o `flowVersionId`.
 *
 * - Mesmo grafo = mesma versão (hash do JSON canônico + versão do formato).
 * - Editar o fluxo gera outra versão; quem está no meio segue na sua (o
 *   snapshot continua congelando o grafo da entrada — skill crmagro-motor §5).
 * - Inscrição ANTIGA (sem `flowVersionId`) continua lendo o próprio
 *   `flowSnapshot`: `snapshotDaInscricao` resolve as duas.
 * - A versão é imutável (nunca é atualizada), então fica em cache em memória
 *   por id — o worker lê o banco uma vez por versão, não uma vez por passo.
 */

/** Valor com as chaves dos objetos em ordem: o JSON canônico do hash. */
function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonico(o[k])]),
    );
  }
  return v;
}

/**
 * Hash do grafo: nós em ordem de id e chaves em ordem (a ordem em que os
 * blocos foram salvos não cria versão nova), com a versão do formato junto
 * (subir `SNAPSHOT_VERSION` nunca reaproveita uma versão do formato antigo).
 */
export function hashDoSnapshot(snapshot: readonly SnapshotNode[], formato: number = SNAPSHOT_VERSION): string {
  const nos = [...snapshot].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify(canonico({ formato, nos })))
    .digest("hex");
}

/**
 * Id da versão do grafo `snapshot` do fluxo: reaproveita a existente (mesmo
 * hash) ou cria. Roda no contexto do time (`db()`). Chamado no nascimento da
 * inscrição (`enroll`, `enrollByTrigger`).
 */
export async function versaoDoFluxo(flowId: string, snapshot: SnapshotNode[]): Promise<string> {
  const prisma = db();
  const hash = hashDoSnapshot(snapshot);
  const existente = await prisma.flowVersion.findUnique({ where: { flowId_hash: { flowId, hash } }, select: { id: true } });
  if (existente) return existente.id;
  try {
    const nova = await prisma.flowVersion.create({
      data: tenantData<Prisma.FlowVersionUncheckedCreateInput>({
        flowId,
        hash,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      }),
      select: { id: true },
    });
    return nova.id;
  } catch (e) {
    // Duas inscrições simultâneas no mesmo grafo novo: a outra gravou primeiro.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const v = await prisma.flowVersion.findUnique({ where: { flowId_hash: { flowId, hash } }, select: { id: true } });
      if (v) return v.id;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Leitura (worker e telas), com cache em memória por versão.
// ---------------------------------------------------------------------------

/** Teto do cache (LRU por reinserção). Um snapshot típico tem poucos KB. */
const CACHE_MAX = 300;
/** `${teamId}:${versionId}` → snapshot. O time na chave: nunca serve versão de outro time. */
const cache = new Map<string, Prisma.JsonValue>();

function lembrar(chave: string, valor: Prisma.JsonValue) {
  cache.delete(chave);
  cache.set(chave, valor);
  if (cache.size > CACHE_MAX) {
    const maisAntiga = cache.keys().next().value;
    if (maisAntiga !== undefined) cache.delete(maisAntiga);
  }
}

/** Só para teste: esvazia o cache de versões. */
export function _limparCacheDeVersoes(): void {
  cache.clear();
}

/**
 * Snapshots de várias versões (id → snapshot): o que está em cache sai dele; o
 * resto vem numa consulta só. Roda no contexto do time (`db()` filtra o time:
 * versão de outro time não volta). O valor devolvido é compartilhado pelo
 * cache — leia, não altere.
 */
export async function snapshotsDasVersoes(ids: readonly string[]): Promise<Map<string, Prisma.JsonValue>> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  const achados = new Map<string, Prisma.JsonValue>();
  const faltam: string[] = [];
  for (const id of new Set(ids)) {
    const chave = `${teamId}:${id}`;
    const emCache = cache.get(chave);
    if (emCache !== undefined) {
      lembrar(chave, emCache);
      achados.set(id, emCache);
    } else {
      faltam.push(id);
    }
  }
  if (faltam.length) {
    const rows = await prisma.flowVersion.findMany({ where: { id: { in: faltam } }, select: { id: true, snapshot: true } });
    for (const r of rows) {
      lembrar(`${teamId}:${r.id}`, r.snapshot);
      achados.set(r.id, r.snapshot);
    }
  }
  return achados;
}

export type InscricaoComSnapshot = { flowVersionId: string | null; flowSnapshot: Prisma.JsonValue | null };

/**
 * Grafo congelado de UMA inscrição: o da versão (inscrição nova) ou o próprio
 * `flowSnapshot` (antiga). `null` = versão não encontrada — quem lê trata como
 * "snapshot ausente" (`lerNoDoSnapshot` → falha visível).
 */
export async function snapshotDaInscricao(enr: InscricaoComSnapshot): Promise<Prisma.JsonValue | null> {
  if (!enr.flowVersionId) return enr.flowSnapshot;
  return (await snapshotsDasVersoes([enr.flowVersionId])).get(enr.flowVersionId) ?? null;
}

/** Grafo de cada inscrição de uma lista (enrollmentId → snapshot), com UMA consulta para as versões. */
export async function snapshotsDasInscricoes(
  rows: ReadonlyArray<{ id: string } & InscricaoComSnapshot>,
): Promise<Map<string, Prisma.JsonValue | null>> {
  const versoes = await snapshotsDasVersoes(rows.flatMap((r) => (r.flowVersionId ? [r.flowVersionId] : [])));
  return new Map(rows.map((r) => [r.id, r.flowVersionId ? (versoes.get(r.flowVersionId) ?? null) : r.flowSnapshot]));
}
