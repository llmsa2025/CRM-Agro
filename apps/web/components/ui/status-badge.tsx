import { StatusDot, type StatusTone } from "@/components/ui/status-dot";

/**
 * Fonte ÚNICA da semântica de relacionamentoStatus (identidade v2: ponto + texto).
 *   novo         → "Nunca contatado"  anel vazado (ainda sem relação)
 *   ja_conversou → "Contatado"        info
 *   cliente      → "Cliente"          ok
 *   opt_out      → "Não quer contato" erro
 * Mudou aqui, mudou em toda a UI.
 */
export const RELACIONAMENTO_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  novo: { label: "Nunca contatado", tone: "empty" },
  ja_conversou: { label: "Contatado", tone: "info" },
  cliente: { label: "Cliente", tone: "ok" },
  opt_out: { label: "Não quer contato", tone: "error" },
};

/** Ordem de exibição em filtros/legendas. */
export const RELACIONAMENTO_OPTS = (["novo", "ja_conversou", "cliente", "opt_out"] as const).map((value) => ({
  value,
  label: RELACIONAMENTO_STATUS[value]!.label,
}));

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const conf = RELACIONAMENTO_STATUS[status] ?? { label: status, tone: "done" as StatusTone };
  return (
    <StatusDot tone={conf.tone} className={className}>
      {conf.label}
    </StatusDot>
  );
}
