"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, MoreVertical, Pencil, Trash2 } from "lucide-react";
import type { JanelaEnvio } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HorarioDoFluxo } from "./HorarioDoFluxo";
import { erroDoHorario } from "./horario";
import { editarFluxoAction, excluirFluxoAction } from "./actions";

/**
 * Menu (três pontinhos) de cada fluxo na lista: editar o nome e o horário de envio, e excluir. Os passos ficam
 * no editor. Quem não pode mudar o fluxo (de outra pessoa, sem "Ver e editar") não vê o menu.
 */
export function MenuDoFluxo({
  id,
  nome,
  janelaEnvio,
  resumoEmpresa,
  emAndamento,
}: {
  id: string;
  nome: string;
  janelaEnvio: JanelaEnvio;
  resumoEmpresa: string;
  /** Contatos que estão no fluxo agora (o aviso de excluir diz quantos saem). */
  emAndamento: number;
}) {
  const router = useRouter();
  const [editando, setEditando] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const [nomeNovo, setNomeNovo] = useState(nome);
  const [janela, setJanela] = useState<JanelaEnvio>(janelaEnvio);
  const [ocupado, setOcupado] = useState(false);

  function abrirEdicao() {
    setNomeNovo(nome);
    setJanela(janelaEnvio);
    setEditando(true);
  }

  async function salvar() {
    if (!nomeNovo.trim()) {
      toast.error("Informe o nome do fluxo");
      return;
    }
    const erro = erroDoHorario(janela);
    if (erro) {
      toast.error("Ajuste o horário de envio", { description: erro });
      return;
    }
    setOcupado(true);
    const res = await editarFluxoAction(id, { nome: nomeNovo.trim(), janelaEnvio: janela });
    setOcupado(false);
    if (res.ok) {
      toast.success("Fluxo atualizado");
      setEditando(false);
      router.refresh();
    } else toast.error("Não salvei", { description: res.error });
  }

  async function excluir() {
    setOcupado(true);
    const res = await excluirFluxoAction(id);
    setOcupado(false);
    if (res.ok) {
      toast.success("Fluxo excluído");
      setExcluindo(false);
      router.refresh();
    } else toast.error("Não excluí", { description: res.error });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Ações do fluxo ${nome}`}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={abrirEdicao}>
            <Pencil className="mr-2 h-4 w-4" />
            Editar nome e horário
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setExcluindo(true)} className="text-danger-500 focus:text-danger-500">
            <Trash2 className="mr-2 h-4 w-4" />
            Excluir
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editando} onOpenChange={setEditando}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar fluxo</DialogTitle>
            <DialogDescription>Os passos ficam no editor do fluxo. Mudar o horário vale já para os contatos que estão nele.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`fluxo-nome-${id}`}>Nome</Label>
              <Input id={`fluxo-nome-${id}`} value={nomeNovo} onChange={(e) => setNomeNovo(e.target.value)} autoFocus />
            </div>
            <div className="border-t border-line pt-3">
              <HorarioDoFluxo value={janela} onChange={setJanela} resumoEmpresa={resumoEmpresa} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditando(false)} disabled={ocupado}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={ocupado || !nomeNovo.trim()}>
              {ocupado ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={excluindo} onOpenChange={setExcluindo}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir o fluxo “{nome}”?</DialogTitle>
            <DialogDescription>
              {emAndamento > 0
                ? `${emAndamento} ${emAndamento === 1 ? "contato está" : "contatos estão"} no fluxo agora e ${emAndamento === 1 ? "sai" : "saem"} dele. `
                : ""}
              As inscrições e o histórico do fluxo saem junto. Não dá para desfazer. Para só parar por um tempo, use Pausar no editor.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExcluindo(false)} disabled={ocupado}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={excluir} disabled={ocupado}>
              {ocupado ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
