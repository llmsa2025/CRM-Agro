"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Users, UserRoundCheck } from "lucide-react";
import { addNoteAction, compartilharContatoAction, deleteContactAction, transferirContatosAction, updateContactAction } from "../actions";
import type { PessoaLite } from "@/components/escopo/filtro-vendedor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CidadeEstadoForm } from "@/components/cidade-estado";
import { TagsInputForm } from "@/components/tags-input";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type EditableContact = {
  id: string;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  telefone: string | null;
  cidade: string | null;
  estado: string | null;
  empresa: string | null;
  cargo: string | null;
  origem: string | null;
  tags: string[];
  areaHa: number | null;
  faturamentoAnual: number | null;
};

/** Número para o campo de edição, no formato pt-BR ("1.250,5"); vazio se não houver. */
const numeroParaCampo = (n: number | null) => (n == null ? "" : n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }));

export function NoteForm({ contactId }: { contactId: string }) {
  const [state, formAction, pending] = useActionState(addNoteAction, undefined);
  return (
    <form action={formAction} className="rounded-lg border bg-card p-3">
      <input type="hidden" name="contactId" value={contactId} />
      <Textarea
        name="conteudo"
        placeholder="Adicionar nota ou registrar atividade…"
        rows={2}
        className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
      />
      <div className="mt-2 flex items-center justify-between">
        {state?.error ? (
          <p className="text-caption text-danger-500">{state.error}</p>
        ) : (
          <span className="text-caption text-muted-foreground">Enter para salvar</span>
        )}
        <Button type="submit" size="xs" disabled={pending}>
          {pending ? "Salvando…" : "Adicionar nota"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  inputMode,
  placeholder,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  inputMode?: "decimal" | "text";
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`edit-${name}`}>{label}</Label>
      <Input id={`edit-${name}`} name={name} type={type} defaultValue={defaultValue} inputMode={inputMode} placeholder={placeholder} />
    </div>
  );
}

function EditContactDialog({
  contact,
  open,
  onOpenChange,
}: {
  contact: EditableContact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(updateContactAction, undefined);

  useEffect(() => {
    if (state?.ok) {
      onOpenChange(false);
      router.refresh();
    }
  }, [state?.ok, onOpenChange, router]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Editar contato</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="id" value={contact.id} />
          <div className="grid grid-cols-2 gap-3">
            <Field name="nome" label="Nome" defaultValue={contact.nome} />
            <Field name="sobrenome" label="Sobrenome" defaultValue={contact.sobrenome ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field name="telefone" label="Telefone" defaultValue={contact.telefone ?? ""} />
            <Field name="email" label="E-mail" type="email" defaultValue={contact.email ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field name="empresa" label="Empresa" defaultValue={contact.empresa ?? ""} />
            <Field name="cargo" label="Cargo" defaultValue={contact.cargo ?? ""} />
          </div>
          <CidadeEstadoForm idPrefix="edit-local" cidadeInicial={contact.cidade} estadoInicial={contact.estado} />
          <div className="grid grid-cols-2 gap-3">
            <Field name="areaHa" label="Área (ha)" defaultValue={numeroParaCampo(contact.areaHa)} inputMode="decimal" placeholder="1.250" />
            <Field
              name="faturamentoAnual"
              label="Faturamento anual (R$)"
              defaultValue={numeroParaCampo(contact.faturamentoAnual)}
              inputMode="decimal"
              placeholder="2.400.000"
            />
          </div>
          <Field name="origem" label="Origem" defaultValue={contact.origem ?? ""} />
          <div className="space-y-1">
            <Label htmlFor="edit-tags">Tags</Label>
            <TagsInputForm id="edit-tags" inicial={contact.tags} />
          </div>
          {state?.error && <p className="text-caption text-danger-500">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Salvando…" : "Salvar alterações"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Dono e compartilhamento do contato (F3d/F4): o que o menu pode oferecer. */
export type DonoDoContato = {
  compartilhado: boolean;
  /** Dono ou administrador: pode "Compartilhar com o time" / "Só eu". */
  podeCompartilhar: boolean;
  /** Pessoas ativas para "Transferir para" (vazio = não é administrador). */
  transferirPara: PessoaLite[];
};

export function ContactActions({ contact, dono }: { contact: EditableContact; dono?: DonoDoContato }) {
  const [, formAction, pending] = useActionState(deleteContactAction, undefined);
  const [editOpen, setEditOpen] = useState(false);
  const router = useRouter();

  async function compartilhar(valor: boolean) {
    const r = await compartilharContatoAction(contact.id, valor);
    if (r.ok) {
      toast.success(valor ? "Contato compartilhado com o time" : "Contato visível só para o dono");
      router.refresh();
    } else toast.error("Não deu para mudar", { description: r.error });
  }

  async function transferir(p: PessoaLite) {
    if (!confirm(`Mudar o responsável de ${contact.nome} para ${p.nome}? O contato, os negócios e todo o histórico passam para ${p.nome}.`)) return;
    const r = await transferirContatosAction({ ids: [contact.id], para: p.id });
    if (r.ok) {
      toast.success(`${p.nome} agora é o responsável por ${contact.nome}`);
      router.refresh();
    } else toast.error("Não deu para mudar o responsável", { description: r.error });
  }
  return (
    <>
      <form action={formAction} className="hidden">
        <input type="hidden" name="id" value={contact.id} />
        <button type="submit" data-delete-submit />
      </form>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Ações do contato">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setEditOpen(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Editar contato
          </DropdownMenuItem>
          {dono?.podeCompartilhar && (
            <DropdownMenuItem onSelect={() => void compartilhar(!dono.compartilhado)}>
              <Users className="mr-2 h-4 w-4" />
              {dono.compartilhado ? "Deixar só com o dono" : "Compartilhar com o time"}
            </DropdownMenuItem>
          )}
          {dono && dono.transferirPara.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UserRoundCheck className="mr-2 h-4 w-4" />
                Mudar responsável
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {dono.transferirPara.map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => void transferir(p)}>
                    {p.nome}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending}
            className="text-danger-500 focus:text-danger-500"
            onSelect={(e) => {
              if (!confirm("Excluir este contato? Esta ação não pode ser desfeita.")) {
                e.preventDefault();
                return;
              }
              document.querySelector<HTMLButtonElement>("[data-delete-submit]")?.click();
            }}
          >
            {pending ? "Excluindo…" : "Excluir contato"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} />
    </>
  );
}
