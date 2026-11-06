"use client";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PhoneCall, ExternalLink, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { loadPendingCallsAction, loadDealOptionsAction, finishManualCallAction } from "./actions";
import { mensagemDoResultado } from "./resultado";
import type { FunnelOption } from "./ManualDialerDialog";

export type PendingCallItem = {
  kind: "scheduled" | "pending_activity";
  id: string;
  callId: string | null;
  contactId: string;
  contactNome: string;
  contactEmpresa: string | null;
  telefone: string | null;
  status: string;
  disposition: string | null;
  notes: string | null;
  provider: string | null;
  createdAt: string;
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Aba Atividades: ligações pendentes (calls scheduled/ringing do discador +
 * Activities call pending do nó manual_call do fluxo). Para pendências com
 * callId (discador pop-up/progressivo), permite "Marcar feita" abrindo o
 * pop-up de finalização (desfecho + negócio/etapa). Para pendências do fluxo
 * (sem callId), encaminha para a aba Histórico do fluxo — o vendedor decide lá.
 */
export function AtividadesTab({
  initial,
  funnels,
  onRefresh,
}: {
  initial: PendingCallItem[];
  funnels: FunnelOption[];
  onRefresh: () => void;
}) {
  const [items, setItems] = useState(initial);
  const [refreshing, startRefresh] = useTransition();
  const [finalizando, setFinalizando] = useState<PendingCallItem | null>(null);

  function refresh() {
    startRefresh(async () => {
      const res = await loadPendingCallsAction();
      setItems(res);
      onRefresh();
    });
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Sem pendências"
        description="Ligações em andamento (discador) ou travadas no fluxo (ligação manual) aparecem aqui."
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-caption text-muted-foreground">
          {items.length} pendência{items.length === 1 ? "" : "s"}
        </p>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Atualizar
        </Button>
      </div>
      <div className="space-y-2">
        {items.map((p) => (
          <div key={p.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/contatos/${p.contactId}`} className="font-medium hover:underline">
                {p.contactNome}
              </Link>
              {p.contactEmpresa && (
                <span className="text-caption text-muted-foreground">{p.contactEmpresa}</span>
              )}
              <Badge variant={p.kind === "pending_activity" ? "info" : "warning"}>
                {p.kind === "pending_activity" ? "Ligação do fluxo" : "Em andamento"}
              </Badge>
              {p.notes && (
                <span className="truncate text-caption text-muted-foreground">· {p.notes}</span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-caption text-muted-foreground">
              <PhoneCall className="h-3.5 w-3.5" />
              <span className="tabular-nums">{p.telefone ?? "—"}</span>
              <span>· {formatTime(p.createdAt)}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {p.callId ? (
                <Button size="sm" onClick={() => setFinalizando(p)}>
                  <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Marcar feita
                </Button>
              ) : (
                <Badge variant="outline-muted" className="text-caption">
                  Finalize na aba Histórico do fluxo
                </Badge>
              )}
              <Button asChild size="sm" variant="ghost">
                <Link href={`/contatos/${p.contactId}`}>
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Abrir contato
                </Link>
              </Button>
            </div>
          </div>
        ))}
      </div>

      {finalizando?.callId && (
        <FinalizarDialog
          item={finalizando}
          funnels={funnels}
          onClose={() => setFinalizando(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}

function FinalizarDialog({
  item,
  funnels,
  onClose,
  onDone,
}: {
  item: PendingCallItem;
  funnels: FunnelOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<"answered" | "no_answer" | "busy" | "voicemail" | "wrong_number" | "skip">("answered");
  const [notes, setNotes] = useState("");
  const [dealOptions, setDealOptions] = useState<{
    deals: Array<{ id: string; stageId: string; funilNome: string; etapaNome: string; valor: number }>;
    funnels: FunnelOption[];
  } | null>(null);
  const [dealId, setDealId] = useState<string>("__none__");
  const [stageId, setStageId] = useState<string>("");

  // Carrega opções de negócio do contato ao abrir.
  useEffect(() => {
    void (async () => {
      const res = await loadDealOptionsAction(item.contactId);
      if (res.ok) {
        const deals = res.deals ?? [];
        setDealOptions({ deals, funnels: res.funnels ?? [] });
        if (deals.length > 0) {
          const first = deals[0];
          if (first) {
            setDealId(first.id);
            setStageId(first.stageId);
          }
        }
      }
    })();
  }, [item.contactId]);

  function salvar() {
    if (!item.callId) return;
    start(async () => {
      const res = await finishManualCallAction(item.callId!, {
        outcome,
        notes: notes.trim() || undefined,
        dealId: dealId === "__none__" ? undefined : dealId || undefined,
        stageId: stageId || undefined,
      });
      if (res.ok) {
        toast.success(mensagemDoResultado(res));
        onClose();
        onDone();
        router.refresh();
      } else toast.error("Falha", { description: res.error });
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Finalizar ligação com {item.contactNome}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-caption text-muted-foreground">Telefone</label>
            <p className="text-body tabular-nums">{item.telefone ?? "—"}</p>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-muted-foreground">Resultado</label>
            <Select value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="answered">Atendeu</SelectItem>
                <SelectItem value="no_answer">Não atendeu</SelectItem>
                <SelectItem value="busy">Ocupado</SelectItem>
                <SelectItem value="voicemail">Caixa postal</SelectItem>
                <SelectItem value="wrong_number">Número errado</SelectItem>
                <SelectItem value="skip">Pular</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-caption text-muted-foreground">Anotação (opcional)</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Resumo da ligação…"
            />
          </div>
          {dealOptions && dealOptions.deals.length > 0 && (
            <div className="space-y-1">
              <label className="text-caption text-muted-foreground">Vincular ao negócio</label>
              <Select value={dealId} onValueChange={(v) => {
                setDealId(v);
                const d = dealOptions.deals.find((x) => x.id === v);
                if (d) setStageId(d.stageId);
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dealOptions.deals.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.funilNome} · {d.etapaNome}
                    </SelectItem>
                  ))}
                  <SelectItem value="__none__">Não vincular</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {dealId !== "__none__" && dealId && (
            <div className="space-y-1">
              <label className="text-caption text-muted-foreground">Etapa (mover ao finalizar)</label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Manter etapa" />
                </SelectTrigger>
                <SelectContent>
                  {funnels.flatMap((f) =>
                    f.stages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {f.nome} · {s.nome}
                      </SelectItem>
                    )),
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={pending}>
            Finalizar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
