"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { addToFunnelAction } from "@/app/contatos/actions";

export type FunnelOption = {
  id: string;
  nome: string;
  stages: { id: string; nome: string }[];
};

/**
 * Dialog "adicionar contato ao funil". Dois modos:
 * - não-controlado (default): renderiza um botão que abre o dialog.
 * - controlado (passa `open` + `onOpenChange`): sem trigger próprio — abre por
 *   fora (ex.: item de um menu 3-pontinhos na conversa).
 */
export function AddToFunnelDialog({
  contactId,
  funnels,
  open: openProp,
  onOpenChange,
  acao = addToFunnelAction,
}: {
  contactId: string;
  funnels: FunnelOption[];
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  /** Server action da tela onde o botão aparece (padrão: a de Contatos). */
  acao?: typeof addToFunnelAction;
}) {
  const router = useRouter();
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;

  const [funnelId, setFunnelId] = useState("");
  const [stageId, setStageId] = useState("");
  const [valor, setValor] = useState("");
  const [busy, setBusy] = useState(false);

  const stages = funnels.find((f) => f.id === funnelId)?.stages ?? [];
  const noFunnels = funnels.length === 0;

  function reset() {
    setFunnelId("");
    setStageId("");
    setValor("");
    setBusy(false);
  }

  function setOpen(v: boolean) {
    if (controlled) onOpenChange?.(v);
    else setOpenState(v);
    if (!v) reset();
  }

  async function submit() {
    if (!funnelId || !stageId) {
      toast.error("Escolha o funil e a etapa");
      return;
    }
    setBusy(true);
    const n = valor.trim() ? Number(valor.replace(/\./g, "").replace(",", ".")) : 0;
    const res = await acao({
      contactId,
      funnelId,
      stageId,
      valor: Number.isNaN(n) ? 0 : n,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Card criado no funil");
      setOpen(false);
      router.refresh();
    } else {
      toast.error("Falha ao criar card", { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-brand-500 hover:text-brand-600">
            <Plus className="h-4 w-4" />
            Adicionar a um funil
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar ao funil</DialogTitle>
          <DialogDescription>
            Cria um card deste contato na etapa escolhida de um funil.
          </DialogDescription>
        </DialogHeader>

        {noFunnels ? (
          <p className="py-4 text-body text-muted-foreground">
            Nenhum funil cadastrado ainda. Crie um funil primeiro na página de Funis.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Funil</Label>
              <Select
                value={funnelId}
                onValueChange={(v) => {
                  setFunnelId(v);
                  setStageId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Escolha o funil" />
                </SelectTrigger>
                <SelectContent>
                  {funnels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Etapa</Label>
              <Select value={stageId} onValueChange={setStageId} disabled={!funnelId}>
                <SelectTrigger>
                  <SelectValue placeholder={funnelId ? "Escolha a etapa" : "Escolha o funil antes"} />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="deal-valor">Valor (opcional)</Label>
              <Input
                id="deal-valor"
                inputMode="decimal"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder="0,00"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={submit} disabled={busy || noFunnels || !funnelId || !stageId}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Criar card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
