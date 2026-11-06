"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PhoneCall, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createManualCallAction, finishManualCallAction, ligarPelaVoopiAction, loadDealOptionsAction, voopiProntaAction } from "./actions";
import { mensagemDoResultado } from "./resultado";

export type FunnelOption = {
  id: string;
  nome: string;
  stages: Array<{ id: string; nome: string }>;
};

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type Fase = "numero" | "chamando" | "finalizar";

/**
 * Discador pop-up: número → liga (tel:) → ao fim: descrição + selecionar
 * negócio/etapa (ou criar via modais existentes no card do funil) → grava no
 * histórico do contato. Cria a Call (scheduled) ao iniciar, finaliza ao fim.
 *
 * Se o número pertence a um contato existente, vincula; senão cria um contato
 * mínimo (nome = número) para ancorar a ligação. O vendedor pode enriquecer
 * depois.
 */
export function ManualDialerDialog({
  open,
  onOpenChange,
  funnels,
  presetPhoneNumber,
  presetContactId,
  presetContactName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  funnels: FunnelOption[];
  presetPhoneNumber?: string;
  presetContactId?: string;
  presetContactName?: string;
}) {
  const router = useRouter();
  const [fase, setFase] = useState<Fase>("numero");
  const [numero, setNumero] = useState("");
  const [callId, setCallId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactNome, setContactNome] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Voopi configurada no time → o pop-up oferece "pelo CRM Agro" além do dispositivo.
  const [voopiPronta, setVoopiPronta] = useState(false);
  useEffect(() => {
    voopiProntaAction()
      .then((s) => setVoopiPronta(s.pronta))
      .catch(() => setVoopiPronta(false));
  }, []);
  const [pending, start] = useTransition();

  // Estado de finalização
  const [outcome, setOutcome] = useState<"answered" | "no_answer" | "busy" | "voicemail" | "wrong_number" | "skip">("answered");
  const [notes, setNotes] = useState("");
  const [dealOptions, setDealOptions] = useState<{
    deals: Array<{ id: string; stageId: string; funnelId: string; funilNome: string; etapaNome: string; valor: number }>;
  } | null>(null);
  const [dealId, setDealId] = useState<string>("__none__");
  const [stageId, setStageId] = useState<string>("");

  // Reset ao (re)abrir.
  useEffect(() => {
    if (!open) return;
    setFase("numero");
    setNumero(presetPhoneNumber ?? "");
    setCallId(null);
    setContactId(presetContactId ?? null);
    setContactNome(presetContactName ?? null);
    setElapsed(0);
    setOutcome("answered");
    setNotes("");
    setDealOptions(null);
    setDealId("__none__");
    setStageId("");
  }, [open, presetPhoneNumber, presetContactId, presetContactName]);

  // Cronômetro durante a chamada.
  useEffect(() => {
    if (fase !== "chamando") return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [fase]);

  // Carrega opções de negócio do contato quando chega na fase de finalização.
  useEffect(() => {
    if (fase !== "finalizar" || !contactId) return;
    void (async () => {
      const res = await loadDealOptionsAction(contactId);
      if (res.ok) {
        const deals = res.deals ?? [];
        setDealOptions({ deals });
        if (deals.length > 0) {
          const first = deals[0];
          if (first) {
            setDealId(first.id);
            setStageId(first.stageId);
          }
        }
      }
    })();
  }, [fase, contactId]);

  /** `modo`: "dispositivo" abre o tel: (FaceTime/Telefone); "voopi" pede à Voopi para chamar seu ramal e o contato. */
  function ligar(modo: "dispositivo" | "voopi" = "dispositivo") {
    if (!numero.trim()) {
      toast.error("Informe o número");
      return;
    }
    start(async () => {
      const res = await createManualCallAction(numero, presetContactId);
      if (res.ok && res.callId) {
        setCallId(res.callId);
        setContactId(res.contactId ?? null);
        setContactNome(res.contactNome ?? null);
        if (modo === "voopi") {
          const v = await ligarPelaVoopiAction({ callId: res.callId });
          if (!v.ok) {
            toast.error("Não deu para ligar pela Voopi", { description: v.error });
            return;
          }
          toast.success("A Voopi está chamando o seu ramal", { description: "Atenda e ela liga para o contato." });
        } else {
          // Disca pela operadora/softphone do dispositivo.
          const digits = numero.replace(/[^\d+]/g, "");
          if (digits) window.location.href = `tel:${digits}`;
        }
        setFase("chamando");
      } else {
        toast.error("Falha ao iniciar ligação", { description: res.error });
      }
    });
  }

  function encerrar() {
    setFase("finalizar");
  }

  function salvar() {
    if (!callId) return;
    start(async () => {
      const res = await finishManualCallAction(callId, {
        outcome,
        ...(outcome === "answered" ? { durationSec: elapsed } : {}),
        notes: notes.trim() || undefined,
        dealId: dealId === "__none__" ? undefined : dealId || undefined,
        stageId: stageId || undefined,
      });
      if (res.ok) {
        toast.success(mensagemDoResultado(res));
        onOpenChange(false);
        router.refresh();
      } else toast.error("Falha ao finalizar", { description: res.error });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Discador</DialogTitle>
          <DialogDescription>
            {contactNome && contactNome !== numero
              ? `Ligando para ${contactNome}`
              : "Disque um número para ligar"}
          </DialogDescription>
        </DialogHeader>

        {fase === "numero" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Número</Label>
              <Input
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                inputMode="tel"
                placeholder="+55 66 99999-0000"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && ligar(voopiPronta ? "voopi" : "dispositivo")}
              />
              <p className="text-caption text-muted-foreground/70">
                Se o número pertence a um contato, a ligação grava no histórico dele. Senão, criamos
                um contato mínimo para ancorar.
              </p>
            </div>
            {voopiPronta ? (
              <div className="flex flex-col gap-2">
                <Button className="w-full" size="lg" onClick={() => ligar("voopi")} disabled={pending || !numero.trim()}>
                  <PhoneCall className="mr-1.5 h-4 w-4" /> Ligar pelo CRM Agro (Voopi)
                </Button>
                <Button variant="outline" className="w-full" onClick={() => ligar("dispositivo")} disabled={pending || !numero.trim()}>
                  Ligar pelo computador ou celular
                </Button>
                <p className="text-caption text-muted-foreground/70">Pelo CRM Agro, a Voopi chama o seu ramal primeiro e depois o contato; a ligação fica gravada.</p>
              </div>
            ) : (
              <Button className="w-full" size="lg" onClick={() => ligar("dispositivo")} disabled={pending || !numero.trim()}>
                <PhoneCall className="mr-1.5 h-4 w-4" /> Ligar
              </Button>
            )}
          </div>
        )}

        {fase === "chamando" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <span
              className="text-display font-semibold tabular-nums tracking-tight"
              aria-live="polite"
            >
              {formatDuration(elapsed)}
            </span>
            <p className="text-body text-muted-foreground">Em ligação…</p>
            <div className="flex gap-2">
              <Button variant="destructive" onClick={encerrar} disabled={pending}>
                <PhoneOff className="mr-1.5 h-4 w-4" /> Encerrar
              </Button>
            </div>
          </div>
        )}

        {fase === "finalizar" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Resultado</Label>
              <Select value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="answered">Atendeu</SelectItem>
                  <SelectItem value="no_answer">Não atendeu</SelectItem>
                  <SelectItem value="busy">Ocupado</SelectItem>
                  <SelectItem value="skip">Pular</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Resumo da ligação…"
              />
            </div>
            {dealOptions && dealOptions.deals.length > 0 && (
              <div className="space-y-1">
                <Label>Vincular ao negócio</Label>
                <Select
                  value={dealId}
                  onValueChange={(v) => {
                    setDealId(v);
                    const d = dealOptions.deals.find((x) => x.id === v);
                    if (d) setStageId(d.stageId);
                  }}
                >
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
                <Label>Etapa (mover ao finalizar)</Label>
                <Select value={stageId} onValueChange={setStageId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Manter etapa" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Só etapas do funil do negócio selecionado — mover para a
                        etapa de OUTRO funil corromperia o card (moveDeal não valida). */}
                    {(() => {
                      const sel = dealOptions?.deals.find((d) => d.id === dealId);
                      const escopo = sel ? funnels.filter((f) => f.id === sel.funnelId) : funnels;
                      return escopo.flatMap((f) =>
                        f.stages.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {f.nome} · {s.nome}
                          </SelectItem>
                        )),
                      );
                    })()}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancelar
              </Button>
              <Button onClick={salvar} disabled={pending}>
                Finalizar
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
