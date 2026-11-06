"use client";

import { mensagemParaTela } from "@/lib/erros";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Briefcase,
  Building2,
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  SkipForward,
  User,
  Ban,
  Voicemail,
} from "lucide-react";
import type { DialerOutcome, DialerSession, DialerSlot, DialerStats } from "@crmagro/core";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ligarPelaVoopiAction, voopiProntaAction } from "./actions";

// ─── Fetch helper ───────────────────────────────────────────────────────

/** Chama uma rota do discador e desembrulha erros de domínio em `Error`. */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `Erro ${res.status}`);
  }
  return (await res.json()) as T;
}

// ─── Metadados de outcome (rótulo, cor, ícone) ─────────────────────────────

type OutcomeMeta = {
  outcome: DialerOutcome;
  label: string;
  variant: "success" | "warning" | "destructive" | "outline";
  icon: typeof PhoneCall;
};

const OUTCOMES: OutcomeMeta[] = [
  { outcome: "answered", label: "Atendeu", variant: "success", icon: PhoneCall },
  { outcome: "no_answer", label: "Não atendeu", variant: "warning", icon: PhoneMissed },
  { outcome: "busy", label: "Ocupado", variant: "destructive", icon: PhoneOff },
  { outcome: "voicemail", label: "Caixa postal", variant: "warning", icon: Voicemail },
  { outcome: "wrong_number", label: "Número errado", variant: "destructive", icon: Ban },
  { outcome: "skip", label: "Pular", variant: "outline", icon: SkipForward },
];

const PRIORITY_META: Record<DialerSlot["priority"], { label: string; variant: "warning" | "info" | "outline-muted" }> = {
  alta: { label: "Prioridade alta", variant: "warning" },
  media: { label: "Prioridade média", variant: "info" },
  baixa: { label: "Prioridade baixa", variant: "outline-muted" },
};

/** Segundos → `mm:ss`. */
function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─── Hook do discador ──────────────────────────────────────────────────────

interface UseDialer {
  ready: boolean;
  stats: DialerStats | null;
  slot: DialerSlot | null;
  loadingNext: boolean;
  submitting: boolean;
  calling: boolean;
  elapsed: number;
  startCall: () => void;
  submitOutcome: (outcome: DialerOutcome) => void;
  /** Voopi do time configurada: "Ligar" oferece CRM Agro ou dispositivo. */
  voopiPronta: boolean;
}

/**
 * Estado do discador: sessão do dia, contato atual, cronômetro e estatísticas.
 * O discador não respeita horário comercial — prospecção fria pode acontecer a
 * qualquer hora; a decisão de ligar é do vendedor.
 */
function useDialer(): UseDialer {
  const [ready, setReady] = useState(false);
  const [stats, setStats] = useState<DialerStats | null>(null);
  const [slot, setSlot] = useState<DialerSlot | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [calling, setCalling] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Cronômetro: só corre enquanto a ligação está ativa.
  useEffect(() => {
    if (!calling) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [calling]);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api<DialerStats>("/api/calls/dialer"));
    } catch (e) {
      toast.error("Falha ao carregar estatísticas", { description: mensagemParaTela(e) });
    }
  }, []);

  const fetchNext = useCallback(async () => {
    setLoadingNext(true);
    setCalling(false);
    setElapsed(0);
    try {
      const next = await api<DialerSlot | null>("/api/calls/dialer/next", { method: "POST" });
      setSlot(next);
    } catch (e) {
      toast.error("Falha ao buscar próximo contato", { description: mensagemParaTela(e) });
    } finally {
      setLoadingNext(false);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setReady(false);
    try {
      await api<DialerSession>("/api/calls/dialer", {
        method: "POST",
        body: JSON.stringify({ respectBusinessHours: false }),
      });
    } catch (e) {
      toast.error("Falha ao iniciar sessão do discador", { description: mensagemParaTela(e) });
      return;
    }
    setReady(true);
    await refreshStats();
    await fetchNext();
  }, [refreshStats, fetchNext]);

  // Início da sessão no primeiro render.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const startCall = useCallback(() => {
    setElapsed(0);
    setCalling(true);
  }, []);

  // "Ligar" oferece duas formas quando a Voopi do time está configurada:
  // pelo CRM Agro (a Voopi chama seu ramal e depois o contato) ou pelo
  // computador/celular (link tel:, como sempre foi).
  const [voopiPronta, setVoopiPronta] = useState(false);
  useEffect(() => {
    voopiProntaAction()
      .then((s) => setVoopiPronta(s.pronta))
      .catch(() => setVoopiPronta(false));
  }, []);

  const submitOutcome = useCallback(
    async (outcome: DialerOutcome) => {
      if (!slot || submitting) return;
      setSubmitting(true);
      const durationSec = elapsed;
      try {
        await api("/api/calls/dialer/outcome", {
          method: "POST",
          body: JSON.stringify({
            callId: slot.callId,
            outcome,
            ...(outcome === "answered" ? { durationSec } : {}),
          }),
        });
        const label = OUTCOMES.find((o) => o.outcome === outcome)?.label ?? "Resultado";
        toast.success(`${label} registrado`);
        await refreshStats();
        await fetchNext();
      } catch (e) {
        toast.error("Falha ao registrar resultado", { description: mensagemParaTela(e) });
      } finally {
        setSubmitting(false);
      }
    },
    [slot, submitting, elapsed, refreshStats, fetchNext],
  );

  return {
    voopiPronta,

    ready,
    stats,
    slot,
    loadingNext,
    submitting,
    calling,
    elapsed,
    startCall,
    submitOutcome,
  };
}

// ─── Sub-componentes ───────────────────────────────────────────────────────

/** Célula da faixa de números (identidade v2: em linha, separadas por hairline). */
function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 py-4 pr-6 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-line [&:not(:first-child)]:pl-6">
      <span className="text-small text-ink-2">{label}</span>
      <span className="num font-serif text-num">{value}</span>
    </div>
  );
}

function ContactField({ icon: Icon, value }: { icon: typeof User; value: string }) {
  return (
    <div className="flex items-center gap-2 text-body text-muted-foreground">
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">{value}</span>
    </div>
  );
}

// ─── Componente principal ──────────────────────────────────────────────────

export function DialerClient() {
  const { ready, stats, slot, loadingNext, submitting, calling, elapsed, startCall, submitOutcome, voopiPronta } =
    useDialer();

  const total = stats?.total ?? 0;
  const answered = stats?.answered ?? 0;
  const remaining = stats?.remaining ?? 0;
  const progress = total > 0 ? (answered / total) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Estatísticas em tempo real */}
      <div className="space-y-3">
        <div className="grid grid-cols-3 border-y border-line">
          <StatTile label="Total do dia" value={total} />
          <StatTile label="Atendidas" value={answered} />
          <StatTile label="Restantes" value={remaining} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-caption text-muted-foreground">
            <span>Progresso</span>
            <span>
              {answered}/{total} atendidas
            </span>
          </div>
          <Progress value={progress} indicatorClassName="bg-success-500" />
        </div>
      </div>

      {/* Card do contato atual */}
      {!ready || loadingNext ? (
        <Card>
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      ) : slot ? (
        <AnimatePresence mode="wait">
          <motion.div
            key={slot.callId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <Card>
              <CardContent className="space-y-6 p-6">
                {/* Cabeçalho: nome, prioridade, toques */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <h2 className="text-h2 font-semibold tracking-tight">{slot.contactName}</h2>
                    <div className="flex items-center gap-2 text-h3 tabular-nums">
                      <Phone className="h-5 w-5 text-muted-foreground" aria-hidden />
                      {slot.phoneNumber || "—"}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant={PRIORITY_META[slot.priority].variant}>
                      {PRIORITY_META[slot.priority].label}
                    </Badge>
                    <span className="text-caption text-muted-foreground">
                      {slot.touchCount} {slot.touchCount === 1 ? "toque" : "toques"}
                    </span>
                  </div>
                </div>

                {/* Dados do contato */}
                {(slot.empresa || slot.cargo) && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {slot.empresa && <ContactField icon={Building2} value={slot.empresa} />}
                    {slot.cargo && <ContactField icon={Briefcase} value={slot.cargo} />}
                  </div>
                )}

                {/* Cronômetro + LIGAR + WhatsApp */}
                <div className="flex flex-col items-center gap-4 rounded-lg border bg-muted/40 py-6">
                  <span
                    className="text-display font-semibold tabular-nums tracking-tight"
                    aria-live="polite"
                    aria-label="Duração da ligação"
                  >
                    {formatDuration(elapsed)}
                  </span>
                  <div className="flex items-center gap-3">
                    {voopiPronta && !calling ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="success" size="lg" disabled={submitting} aria-label="Escolher como ligar">
                            <PhoneCall className="h-4 w-4" />
                            Ligar
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="center" className="w-72">
                          <DropdownMenuItem
                            onSelect={async () => {
                              const r = await ligarPelaVoopiAction({ callId: slot.callId });
                              if (r.ok) {
                                toast.success("A Voopi está chamando o seu ramal", { description: "Atenda e ela liga para o contato." });
                                startCall();
                              } else toast.error("Não deu para ligar pela Voopi", { description: r.error });
                            }}
                          >
                            <span className="flex flex-col">
                              <span>Pelo CRM Agro (Voopi)</span>
                              <span className="text-caption text-ink-2">Chama o seu ramal e depois o contato. Fica gravada.</span>
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              if (slot.phoneNumber) window.location.href = `tel:${slot.phoneNumber.replace(/[^\d+]/g, "")}`;
                              startCall();
                            }}
                          >
                            <span className="flex flex-col">
                              <span>Pelo computador ou celular</span>
                              <span className="text-caption text-ink-2">Abre no FaceTime, Telefone ou no app de chamadas.</span>
                            </span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <Button
                        variant="success"
                        size="lg"
                        onClick={() => {
                          // Disca pela operadora/softphone do dispositivo e inicia o cronômetro.
                          if (slot.phoneNumber) {
                            window.location.href = `tel:${slot.phoneNumber.replace(/[^\d+]/g, "")}`;
                          }
                          startCall();
                        }}
                        disabled={calling || submitting}
                        aria-label="Iniciar ligação"
                      >
                        <PhoneCall className="h-4 w-4" />
                        {calling ? "Em ligação…" : "Ligar"}
                      </Button>
                    )}
                    <Button asChild variant="outline" size="lg" aria-label="Abrir WhatsApp">
                      <a
                        href={`/conversas?contact=${slot.contactId}&canal=whatsapp`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <MessageCircle className="h-4 w-4" />
                        WhatsApp
                      </a>
                    </Button>
                  </div>
                </div>

                {/* Botões de resultado */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {OUTCOMES.map(({ outcome, label, variant, icon: Icon }) => (
                    <Button
                      key={outcome}
                      variant={variant}
                      onClick={() => submitOutcome(outcome)}
                      disabled={submitting}
                      aria-label={label}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>
      ) : (
        <EmptyState
          icon={PhoneOff}
          title="Nenhum contato na fila"
          description="Todos os contatos elegíveis já foram tocados hoje. Volte amanhã ou importe novos contatos."
        />
      )}
    </div>
  );
}
