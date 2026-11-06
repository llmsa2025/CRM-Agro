import { StatusDot, type StatusTone } from "@/components/ui/status-dot";

/**
 * Fonte ÚNICA da semântica de `interesse` — eixo ortogonal ao relacionamento
 * (ver status-badge.tsx). Identidade v2: ponto + texto.
 *   nao_avaliado  → anel vazado (ainda não qualificado)
 *   interessado   → ok (avançar)
 *   talvez        → atenção (nutrir)
 *   sem_interesse → erro (não insistir)
 */
export const INTERESSE: Record<string, { label: string; tone: StatusTone }> = {
  nao_avaliado: { label: "Não avaliado", tone: "empty" },
  interessado: { label: "Interessado", tone: "ok" },
  talvez: { label: "Talvez", tone: "attention" },
  sem_interesse: { label: "Sem interesse", tone: "error" },
};

/** Ordem de exibição em menus/toolbars. */
export const INTERESSE_OPTS = (["nao_avaliado", "interessado", "talvez", "sem_interesse"] as const).map(
  (value) => ({ value, label: INTERESSE[value]?.label ?? value }),
);

export function InteresseBadge({ interesse, className }: { interesse: string; className?: string }) {
  const conf = INTERESSE[interesse] ?? { label: interesse, tone: "done" as StatusTone };
  return (
    <StatusDot tone={conf.tone} className={className}>
      {conf.label}
    </StatusDot>
  );
}
