"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileSignature, PenLine, Plus, Trash2, Star, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { SignatureDTO } from "@crmagro/core";
import {
  listSignaturesAction,
  createSignatureAction,
  updateSignatureAction,
  deleteSignatureAction,
} from "../email/actions";
import { RichEditor } from "./RichEditor";

/**
 * Assinaturas de UMA caixa de e-mail (por caixa, 28/09): o dono pode ter 2
 * caixas, cada uma com as suas assinaturas e a sua padrão. Mostra o resumo na
 * linha da caixa (qual é a padrão) e abre o diálogo para criar/editar/excluir.
 * O envio usa sempre a assinatura da caixa que envia.
 */
export function SignaturesManager({
  channelAccountId,
  caixa,
  inicial,
}: {
  channelAccountId: string;
  /** Nome da caixa (título do diálogo). */
  caixa: string;
  /** Assinaturas desta caixa já carregadas pela página. */
  inicial: SignatureDTO[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SignatureDTO[]>(inicial);
  const [editing, setEditing] = useState<SignatureDTO | null>(null);
  const [nome, setNome] = useState("");
  const [html, setHtml] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setList(await listSignaturesAction(channelAccountId));
    router.refresh();
  }

  function novo() {
    setEditing({ id: "", nome: "", html: "", isDefault: false, channelAccountId, caixa });
    setNome("");
    setHtml("");
    setIsDefault(list.length === 0);
  }
  function editar(s: SignatureDTO) {
    setEditing(s);
    setNome(s.nome);
    setHtml(s.html);
    setIsDefault(s.isDefault);
  }

  async function salvar() {
    if (!nome.trim()) {
      toast.error("Dê um nome à assinatura");
      return;
    }
    setSaving(true);
    const res = editing?.id
      ? await updateSignatureAction(editing.id, { nome, html, isDefault })
      : await createSignatureAction({ channelAccountId, nome, html, isDefault });
    setSaving(false);
    if (res.error) return toast.error("Falha ao salvar", { description: res.error });
    toast.success("Assinatura salva");
    setEditing(null);
    await refresh();
  }

  async function excluir(s: SignatureDTO) {
    if (!window.confirm(`Excluir a assinatura "${s.nome}"?`)) return;
    const res = await deleteSignatureAction(s.id);
    if (res.error) return toast.error("Falha ao excluir", { description: res.error });
    toast.success("Assinatura excluída");
    if (editing?.id === s.id) setEditing(null);
    await refresh();
  }

  const padrao = list.find((s) => s.isDefault) ?? null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-caption text-muted-foreground">
      <span className="min-w-0 truncate">
        {list.length === 0
          ? "Sem assinatura nesta caixa"
          : `Assinatura padrão: ${padrao?.nome ?? "nenhuma"}${list.length > 1 ? ` · ${list.length} assinaturas` : ""}`}
      </span>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-caption" title={`Assinaturas da caixa ${caixa}`}>
            <FileSignature className="mr-1.5 h-3.5 w-3.5" />
            {list.length === 0 ? "Criar assinatura" : "Assinaturas"}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Assinaturas · {caixa}</DialogTitle>
            <DialogDescription>
              Valem só para os e-mails enviados por esta caixa. A padrão já vem marcada ao escrever.
            </DialogDescription>
          </DialogHeader>

          {editing ? (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label className="text-caption">Nome</Label>
                <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Comercial, Suporte…" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-caption">Conteúdo</Label>
                <RichEditor value={html} onChange={setHtml} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                Usar como padrão desta caixa
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Voltar</Button>
                <Button onClick={salvar} disabled={saving}>
                  {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
                  Salvar
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex justify-end">
                <Button size="sm" onClick={novo}><Plus className="mr-1.5 h-4 w-4" /> Nova assinatura</Button>
              </div>
              {list.length === 0 ? (
                <p className="py-6 text-center text-caption text-muted-foreground">
                  Nenhuma assinatura nesta caixa ainda. Crie uma para usar ao escrever e-mails por ela.
                </p>
              ) : (
                <div className="divide-y rounded-md border">
                  {list.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <button type="button" onClick={() => editar(s)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        <span className="truncate font-medium">{s.nome}</span>
                        {s.isDefault && (
                          <span className="inline-flex items-center gap-1 text-caption text-ink-3">
                            <Star className="h-3 w-3" /> padrão
                          </span>
                        )}
                      </button>
                      <Button variant="ghost" size="icon-sm" onClick={() => editar(s)} aria-label={`Editar a assinatura ${s.nome}`} title="Editar assinatura">
                        <PenLine className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void excluir(s)}
                        aria-label={`Excluir a assinatura ${s.nome}`}
                        title="Excluir assinatura"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
