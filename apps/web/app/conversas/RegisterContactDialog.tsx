"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContatoForm, type DadosDoCadastro } from "../contatos/ContatoForm";
import { cadastrarContatoDaConversaAction } from "./actions";

/** Separa "Maria Souza" em nome e sobrenome (o cadastro tem os dois campos; a lista mostra juntos). */
function separarNome(completo: string | null): { nome: string; sobrenome: string } {
  const partes = (completo ?? "").trim().split(/\s+/).filter(Boolean);
  return { nome: partes[0] ?? "", sobrenome: partes.slice(1).join(" ") };
}

/**
 * "Cadastrar contato" a partir da conversa: o MESMO formulário da tela "Novo contato" (pessoa e empresa), num
 * pop-up que rola até o fim. Traz o nome da agenda e o número da conversa; o status já vem como "Contatado".
 */
export function RegisterContactDialog({
  conversationId,
  suggestedName,
  externalNumber,
  open,
  onOpenChange,
  onRegistered,
}: {
  conversationId: string;
  /** Nome já validado no servidor (agenda > pushName; nunca número nem rótulo). */
  suggestedName: string | null;
  externalNumber: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRegistered: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [existente, setExistente] = useState<string | null>(null);
  const semNumero = !!externalNumber?.endsWith("@lid");
  const { nome, sobrenome } = separarNome(suggestedName);

  async function salvar(d: DadosDoCadastro) {
    setBusy(true);
    setExistente(null);
    const res = await cadastrarContatoDaConversaAction({ conversationId, ...d });
    setBusy(false);
    if (res.ok) {
      if (res.jaExistia) toast.success(`Este número já era de ${res.nome}`, { description: "A conversa foi ligada a esse contato. O que você digitou não foi aplicado." });
      else toast.success("Contato cadastrado");
      onOpenChange(false);
      onRegistered();
      router.refresh();
    } else {
      if (res.existenteId) setExistente(res.existenteId);
      toast.error("Não foi cadastrado", { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(a) => !busy && onOpenChange(a)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cadastrar contato</DialogTitle>
          <DialogDescription>Os mesmos dados da tela Novo contato. Só o nome é obrigatório, além do responsável.</DialogDescription>
        </DialogHeader>
        {open && (
          <ContatoForm
            variante="janela"
            inicial={{ nome, sobrenome, telefone: semNumero ? "" : externalNumber ?? "" }}
            statusInicial="ja_conversou"
            telefoneObrigatorio={semNumero}
            salvando={busy}
            rotuloSalvar="Cadastrar"
            contatoExistenteId={existente}
            onSalvar={salvar}
            onCancelar={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
