import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/format";

/** Rótulo curto por tipo de nó (espelha o handler do worker). */
const NODE_LABEL: Record<string, string> = {
  send_message: "mensagem",
  send_email: "e-mail",
  send_social: "DM social",
  switch_flow: "mudar de fluxo",
  typing: "digitando",
  wait: "espera",
  condition: "condição",
  ab_split: "teste A/B",
  update_stage: "etapa",
  add_tag: "tag",
  notify_user: "notificar",
  http_request: "http",
  ai_agent: "IA",
  manual_call: "ligação",
};

const RUN_STATUS: Record<string, { label: string; variant: "info" | "warning" | "success" | "destructive" | "outline-muted" }> = {
  active: { label: "Ativo", variant: "info" },
  waiting: { label: "Aguardando", variant: "warning" },
  done: { label: "Concluído", variant: "success" },
  failed: { label: "Falhou", variant: "destructive" },
};

type Step = {
  id: string;
  nodeType: string | null;
  round: number;
  status: string;
  skipped: boolean;
  error: string | null;
  detail: string | null; // o que o passo fez (motivo, ou onde o agente de conversa está)
  /** Qual saída a condição (ou o teste A/B) seguiu: texto curto para o balão e frase inteira para a dica. */
  escolha?: { curto: string; longo: string } | null;
  at: string;
  repeat: number; // execuções consecutivas colapsadas (re-checks da condição)
};
type Run = {
  id: string;
  contactId: string;
  contactNome: string;
  /** Caminho paralelo de uma saída com vários destinos. */
  ramo?: boolean;
  status: string;
  /** Por que está assim agora (último motivo ou erro dos passos). */
  resumo?: string | null;
  /** Segurada pela pausa do fluxo (continua de onde parou ao ativar). */
  pausada?: boolean;
  stepNumber: number;
  nextRunAt: string | null;
  createdAt: string;
  steps: Step[];
};

/** Log de execuções recentes do fluxo — prova de que rodou e por onde passou. */
export function FlowRuns({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border p-4 text-body text-muted-foreground">
        Nenhuma execução ainda. Ative o fluxo e dispare o gatilho (ou use “Testar” acima). As
        execuções aparecem aqui com cada passo.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => {
        const st = run.pausada
          ? { label: "Pausado", variant: "outline-muted" as const }
          : (RUN_STATUS[run.status] ?? { label: run.status, variant: "outline-muted" as const });
        return (
          <div key={run.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/contatos/${run.contactId}`} className="text-body font-medium hover:underline">
                {run.contactNome}
              </Link>
              {run.ramo && <span className="text-caption text-muted-foreground">caminho paralelo</span>}
              <Badge variant={st.variant}>{st.label}</Badge>
              <span className="text-caption text-muted-foreground">
                {run.stepNumber} passo(s) · iniciado {relativeTime(new Date(run.createdAt))}
              </span>
              {run.status === "waiting" && !run.pausada && run.nextRunAt && (
                <span className="text-caption text-warning-700">
                  próximo {relativeTime(new Date(run.nextRunAt))}
                </span>
              )}
            </div>
            {run.steps.length > 0 && (
              <ol className="mt-2 flex flex-wrap items-center gap-1.5">
                {run.steps.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-muted-foreground/40">→</span>}
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-caption " +
                        (s.status === "failed"
                          ? "bg-danger-100 text-danger-700"
                          : s.skipped
                            ? "bg-muted text-muted-foreground line-through"
                            : "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-500")
                      }
                      title={
                        s.error ??
                        s.escolha?.longo ??
                        s.detail ??
                        (s.repeat > 1
                          ? `${s.repeat} verificações (a condição re-checou enquanto aguardava resposta)`
                          : undefined)
                      }
                    >
                      {NODE_LABEL[s.nodeType ?? ""] ?? s.nodeType ?? "?"}
                      {s.repeat > 1 ? ` ×${s.repeat}` : ""}
                      {s.escolha ? `: ${s.escolha.curto}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {run.resumo && <p className="mt-1.5 text-caption text-muted-foreground">{run.resumo}</p>}
          </div>
        );
      })}
    </div>
  );
}
