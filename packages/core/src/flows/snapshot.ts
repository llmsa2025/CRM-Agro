import { snapshotNodeSchema, type SnapshotNode } from "./schema";

/**
 * Leitura do snapshot da inscrição (item 1.9 — MF-18).
 *
 * Antes, o worker validava o snapshot INTEIRO com o schema atual a cada passo:
 * qualquer evolução do schema dos nós (campo obrigatório novo, enum renomeado)
 * marcava `failed` TODAS as inscrições em voo no próximo passo, com o motivo só
 * no console. E um `nextNodeId` para nó inexistente encerrava a inscrição como
 * `done` — o painel contava como "concluído".
 *
 * Agora: só o nó CORRENTE é validado, depois de passar pelo migrador da versão
 * em que a inscrição nasceu (`Enrollment.snapshotVersion`); nó ausente é falha
 * visível ("destino inexistente").
 */

/** Versão do formato gravada nas inscrições novas. Subiu o formato? Suba aqui e escreva o migrador. */
export const SNAPSHOT_VERSION = 1;

/**
 * Migradores: nó cru da versão N → formato da versão N+1. Vazio enquanto o
 * formato for o 1. Ex.: `2: (no) => ({ ...no, config: { ...no.config, novoCampo: padrão } })`.
 */
const MIGRADORES: Record<number, (no: Record<string, unknown>) => Record<string, unknown>> = {};

export type LeituraDoNo =
  | { ok: true; node: SnapshotNode }
  | { ok: false; motivo: "snapshot_invalido" | "destino_inexistente" | "no_invalido"; erro: string };

export function lerNoDoSnapshot(snapshot: unknown, nodeId: string, versao = SNAPSHOT_VERSION): LeituraDoNo {
  if (!Array.isArray(snapshot)) return { ok: false, motivo: "snapshot_invalido", erro: "snapshot do fluxo ausente ou corrompido" };
  const cru = snapshot.find((n) => !!n && typeof n === "object" && (n as { id?: unknown }).id === nodeId) as
    | Record<string, unknown>
    | undefined;
  if (!cru) return { ok: false, motivo: "destino_inexistente", erro: `destino inexistente: o nó ${nodeId} não está no fluxo` };
  let no = cru;
  for (let v = versao + 1; v <= SNAPSHOT_VERSION; v++) no = MIGRADORES[v]?.(no) ?? no;
  const parsed = snapshotNodeSchema.safeParse(no);
  if (!parsed.success) {
    const detalhe = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "nó"}: ${i.message}`)
      .join("; ");
    return { ok: false, motivo: "no_invalido", erro: `nó ${nodeId} (${String(cru.tipo)}) inválido: ${detalhe}`.slice(0, 500) };
  }
  return { ok: true, node: parsed.data };
}

/** Destinos de um nó (próximo, ramos da condição, variantes do A/B). */
export function destinosDoNo(no: { tipo: string; nextNodeId?: string | null; branches?: unknown }): string[] {
  const alvos: string[] = [];
  if (no.nextNodeId) alvos.push(no.nextNodeId);
  const b = no.branches as {
    branches?: Array<{ nextNodeId?: string; maisDestinos?: string[] }>;
    variants?: Array<{ nextNodeId?: string }>;
    default?: string | null;
    defaultMais?: string[];
  } | null;
  for (const r of b?.branches ?? []) {
    if (r?.nextNodeId) alvos.push(r.nextNodeId);
    alvos.push(...(r?.maisDestinos ?? []));
  }
  for (const r of b?.variants ?? []) if (r?.nextNodeId) alvos.push(r.nextNodeId);
  if (b?.default) alvos.push(b.default);
  alvos.push(...(b?.defaultMais ?? []));
  return alvos;
}

/**
 * Setas que apontam para nó que não existe no grafo. Fluxo ATIVO com seta
 * solta mandava o contato para um "destino inexistente" no meio do caminho.
 */
export function referenciasPendentes(
  nos: Array<{ id: string; tipo: string; nextNodeId?: string | null; branches?: unknown }>,
): Array<{ de: string; para: string }> {
  const ids = new Set(nos.map((n) => n.id));
  const soltas: Array<{ de: string; para: string }> = [];
  for (const n of nos) for (const alvo of destinosDoNo(n)) if (!ids.has(alvo)) soltas.push({ de: n.id, para: alvo });
  return soltas;
}
