"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deleteFunnelAction, renameFunnelAction } from "./actions";

/** Ações do funil na listagem: 3 pontinhos → Editar (renomear) / Excluir. */
export function FunnelActions({ id, nome }: { id: string; nome: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [novoNome, setNovoNome] = useState(nome);

  function excluir() {
    if (!confirm(`Excluir o funil "${nome}"? Esta ação não pode ser desfeita.`)) return;
    startTransition(async () => {
      const res = await deleteFunnelAction(id);
      if (res.ok) {
        toast.success(`Funil "${nome}" excluído`);
        router.refresh();
      } else {
        toast.error("Não foi possível excluir", { description: res.error });
      }
    });
  }

  function salvarNome() {
    startTransition(async () => {
      const res = await renameFunnelAction(id, novoNome);
      if (res.ok) {
        toast.success("Funil atualizado");
        setEditOpen(false);
        router.refresh();
      } else {
        toast.error("Não foi possível salvar", { description: res.error });
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost-subtle" size="icon-sm" aria-label={`Ações do funil ${nome}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setNovoNome(nome);
              setEditOpen(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Editar
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-danger-700 focus:bg-danger-100"
            onSelect={(e) => {
              e.preventDefault();
              excluir();
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Excluir
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar funil</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="funnel-nome">Nome do funil</Label>
            <Input
              id="funnel-nome"
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && salvarNome()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={salvarNome} disabled={pending || !novoNome.trim()}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
