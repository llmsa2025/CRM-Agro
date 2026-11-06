"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Loader2, Plus, X } from "lucide-react";
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
import { createFunnelAction } from "./actions";

type Tipo = "pre_vendas" | "vendas" | "follow_up";
const TIPOS: { value: Tipo; label: string }[] = [
  { value: "pre_vendas", label: "Pré-vendas" },
  { value: "vendas", label: "Vendas" },
  { value: "follow_up", label: "Follow-up" },
];

const ETAPAS_PADRAO = ["Novo", "Em contato", "Proposta", "Fechado"];

export function NewFunnelButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<Tipo>("vendas");
  const [stages, setStages] = useState<string[]>(ETAPAS_PADRAO);
  const [busy, setBusy] = useState(false);

  function setStage(i: number, v: string) {
    setStages((s) => s.map((x, idx) => (idx === i ? v : x)));
  }
  function addStage() {
    setStages((s) => [...s, ""]);
  }
  function removeStage(i: number) {
    setStages((s) => s.filter((_, idx) => idx !== i));
  }
  function moveStage(i: number, dir: -1 | 1) {
    setStages((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  async function submit() {
    if (!nome.trim()) {
      toast.error("Informe o nome do funil");
      return;
    }
    const etapas = stages.map((s) => s.trim()).filter(Boolean);
    if (etapas.length === 0) {
      toast.error("Adicione ao menos uma etapa");
      return;
    }
    setBusy(true);
    const res = await createFunnelAction({ nome: nome.trim(), tipo, stages: etapas });
    setBusy(false);
    if (res.ok) {
      toast.success("Funil criado");
      setOpen(false);
      setNome("");
      setTipo("vendas");
      setStages(ETAPAS_PADRAO);
      if (res.id) router.push(`/funis/${res.id}`);
      else router.refresh();
    } else {
      toast.error("Falha ao criar funil", { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Novo funil
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo funil</DialogTitle>
          <DialogDescription>
            Monte as etapas e a sequência do funil. Cada etapa ganha um código estável
            para as automações referenciarem.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="funnel-nome">Nome</Label>
            <Input
              id="funnel-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: Vendas Q3"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={(v) => setTipo(v as Tipo)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Etapas (colunas)</Label>
            {stages.map((s, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-5 text-caption text-muted-foreground">{i + 1}.</span>
                <Input
                  value={s}
                  onChange={(e) => setStage(i, e.target.value)}
                  placeholder={`Etapa ${i + 1}`}
                  className="h-8"
                />
                <Button
                  type="button"
                  variant="ghost-subtle"
                  size="icon-sm"
                  onClick={() => moveStage(i, -1)}
                  disabled={i === 0}
                  aria-label="Subir"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost-subtle"
                  size="icon-sm"
                  onClick={() => moveStage(i, 1)}
                  disabled={i === stages.length - 1}
                  aria-label="Descer"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost-subtle"
                  size="icon-sm"
                  onClick={() => removeStage(i)}
                  disabled={stages.length <= 1}
                  aria-label="Remover etapa"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addStage}>
              <Plus className="mr-1.5 h-4 w-4" />
              Adicionar etapa
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !nome.trim()}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Criar funil
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
