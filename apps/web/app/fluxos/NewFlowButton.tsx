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
import { createFlowAction } from "./actions";
import { HorarioDoFluxo } from "./HorarioDoFluxo";
import { erroDoHorario, horarioPadraoDoFluxoNovo } from "./horario";
import type { JanelaEnvio } from "@crmagro/core";

const TRIGGERS = [
  { value: "contact_created", label: "Contato criado" },
  { value: "message_received", label: "Mensagem recebida" },
  { value: "stage_changed", label: "Mudança de etapa" },
  { value: "manual", label: "Manual" },
  { value: "contacts_selected", label: "Contatos selecionados" },
];

/** Um tipo de fluxo como a tela mostra (a página monta a partir das regras do core, `flows/tipos.ts`). */
export type TipoParaATela = {
  value: string;
  nome: string;
  descricao: string;
  /** Dá para criar hoje? Senão aparece desligado, como "em breve". */
  disponivel: boolean;
  /** Gatilhos que o tipo aceita. */
  gatilhos: string[];
};

export function NewFlowButton({ resumoEmpresa, tipos }: { resumoEmpresa: string; tipos: TipoParaATela[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [trigger, setTrigger] = useState("manual");
  const [tipo, setTipo] = useState(tipos.find((t) => t.disponivel)?.value ?? "prospeccao");
  // O horário já nasce preenchido (seg a sex, 08:00 às 18:00): a pessoa confere e ajusta aqui mesmo.
  const [janela, setJanela] = useState<JanelaEnvio>(horarioPadraoDoFluxoNovo);
  const [busy, setBusy] = useState(false);

  const tipoAtual = tipos.find((t) => t.value === tipo);
  const gatilhosDoTipo = TRIGGERS.filter((t) => tipoAtual?.gatilhos.includes(t.value) ?? true);

  function escolherTipo(novo: string) {
    setTipo(novo);
    // O gatilho que o novo tipo não aceita volta para o primeiro que ele aceita.
    const aceitos = tipos.find((t) => t.value === novo)?.gatilhos ?? [];
    if (!aceitos.includes(trigger)) setTrigger(TRIGGERS.find((t) => aceitos.includes(t.value))?.value ?? "manual");
  }

  async function submit() {
    if (!nome.trim()) {
      toast.error("Informe o nome do fluxo");
      return;
    }
    const erro = erroDoHorario(janela);
    if (erro) {
      toast.error("Ajuste o horário de envio", { description: erro });
      return;
    }
    setBusy(true);
    const res = await createFlowAction({ nome: nome.trim(), tipo, triggerType: trigger, janelaEnvio: janela });
    setBusy(false);
    if (res.ok && res.id) {
      toast.success("Fluxo criado");
      setOpen(false);
      setNome("");
      setJanela(horarioPadraoDoFluxoNovo());
      router.push(`/fluxos/${res.id}`);
    } else {
      toast.error("Falha ao criar fluxo", { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Novo fluxo
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo fluxo</DialogTitle>
          <DialogDescription>
            Cria um fluxo em rascunho. Você adiciona os passos no editor visual e muda o horário quando quiser.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="flow-nome">Nome</Label>
            <Input id="flow-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Primeiro contato WhatsApp" autoFocus />
          </div>
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={escolherTipo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tipos.map((t) => (
                  <SelectItem key={t.value} value={t.value} disabled={!t.disponivel}>
                    {t.nome}
                    {t.disponivel ? "" : " (em breve)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tipoAtual && <p className="text-caption text-ink-3">{tipoAtual.descricao} O tipo não muda depois de criado.</p>}
          </div>
          <div className="space-y-1">
            <Label>Gatilho</Label>
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gatilhosDoTipo.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="border-t border-line pt-3">
            <HorarioDoFluxo value={janela} onChange={setJanela} resumoEmpresa={resumoEmpresa} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !nome.trim()}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Criar fluxo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
