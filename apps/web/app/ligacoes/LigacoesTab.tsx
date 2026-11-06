"use client";

import { PhoneCall, PhoneIncoming, PhoneMissed, PhoneOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import Link from "next/link";

export type CallActivityItem = {
  id: string;
  contactId: string;
  contactNome: string;
  contactEmpresa: string | null;
  telefone: string | null;
  email: string | null;
  direcao: "in" | "out" | null;
  conteudo: string | null;
  meta: Record<string, unknown> | null;
  dealId: string | null;
  createdAt: string;
};

function outcomeBadge(meta: Record<string, unknown> | null, conteudo: string | null) {
  const outcome = (meta as { outcome?: string } | null)?.outcome;
  if (outcome === "answered") return { label: "Atendida", variant: "success" as const };
  if (outcome === "no_answer") return { label: "Não atendida", variant: "warning" as const };
  if (outcome === "busy") return { label: "Ocupado", variant: "destructive" as const };
  if (outcome === "skip") return { label: "Pulada", variant: "outline-muted" as const };
  if (conteudo?.toLowerCase().includes("pendente")) return { label: "Pendente", variant: "warning" as const };
  return { label: "Registrada", variant: "outline-muted" as const };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Aba Ligações: histórico de Activities de ligação (hoje). Cada item mostra
 * contato, telefone, outcome (badge), duração (se houver) e horário. Clicar no
 * contato abre o detalhe. A paginação por cursor fica para depois — hoje o
 * volume é baixo (carregamos 100 no server).
 */
export function LigacoesTab({
  initial,
}: {
  initial: { items: CallActivityItem[]; nextCursor: string | null };
}) {
  if (initial.items.length === 0) {
    return (
      <EmptyState
        icon={PhoneCall}
        title="Nenhuma ligação hoje"
        description="Ligações feitas pelo discador ou pelo pop-up aparecem aqui ao longo do dia."
      />
    );
  }

  return (
    <div className="divide-y rounded-lg border">
      {initial.items.map((a) => {
        const badge = outcomeBadge(a.meta, a.conteudo);
        const meta = a.meta as { durationSec?: number } | null;
        const isIn = a.direcao === "in";
        const Icon = isIn ? PhoneIncoming : badge.label === "Não atendida" ? PhoneMissed : badge.label === "Ocupado" ? PhoneOff : PhoneCall;
        return (
          <div key={a.id} className="flex items-center gap-3 p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link
                  href={`/contatos/${a.contactId}`}
                  className="truncate font-medium hover:underline"
                >
                  {a.contactNome}
                </Link>
                {a.contactEmpresa && (
                  <span className="truncate text-caption text-muted-foreground">
                    {a.contactEmpresa}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-caption text-muted-foreground">
                <span className="tabular-nums">{a.telefone ?? "—"}</span>
                {a.conteudo && <span className="truncate">· {a.conteudo}</span>}
                {meta?.durationSec ? (
                  <span className="tabular-nums">· {meta.durationSec}s</span>
                ) : null}
              </div>
            </div>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <span className="text-caption tabular-nums text-muted-foreground">
              {formatTime(a.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
